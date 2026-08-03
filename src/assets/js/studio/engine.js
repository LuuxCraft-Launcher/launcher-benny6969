/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 *
 * LuuxCraft Studio — launcher runtime engine.
 *
 * When the panel ships a Studio Pro layout (`config.studio`), this engine fully
 * replaces the launcher's built-in home/login/settings panels: it mounts the
 * free-form layout, scales the 1920×1080 virtual stage to the window, resolves
 * dynamic `{variables}`, wires element actions (play, login, navigation…) and
 * fills the dynamic widgets (server status, news, social links, instance
 * picker, account manager) with real data.
 */

import { mountElement, buildStatesStyleSheet, applyVariables, renderElementContent, applyFill } from './render.js';
import { config, database, popup, skin2D, pkg, getErrorMessage, appdata } from '../utils.js';

const { AZauth, Mojang, Status, Launch } = require('minecraft-java-core');
const { ipcRenderer, shell } = require('electron');

const PAGE_IDS = ['home', 'login', 'settings'];
const STATIC_BOUND_TYPES = new Set(['text', 'button', 'image', 'input_text', 'progressbar']);

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Accent colour for dynamic widgets: the element's visible border, else green. */
function accentOf(el) {
    const b = el && el.style && el.style.border;
    if (b && b.style !== 'none' && b.width > 0 && b.color) return b.color;
    return '#22c55e';
}

export default class StudioEngine {
    constructor(serverConfig) {
        this.config = serverConfig || {};
        this.doc = this.config.studio;
        this.db = new database();
        this.vars = {
            '{player_username}': 'Invité',
            '{player_uuid}': '',
            '{player_avatar}': '',
            '{player_online}': '0',
            '{player_max}': '0',
            '{server_status}': 'Hors ligne',
            '{server_name}': 'Serveur',
            '{download_percentage}': '0',
            '{ram_max}': '',
            '{launcher_version}': pkg.version || '1.0.0',
        };
        this.pageEls = {};
        this.stages = [];
        this.bindings = [];            // static elements referencing {variables}
        this.serverStatusWidgets = []; // live server-status widget refs
        this.accountLists = [];        // { inner, el } account_list widgets
        this.instances = null;         // cached instance list
        this.launching = false;
        this.current = 'home';
        this._onResize = () => this.layout();
    }

    async init() {
        this.injectRuntimeCss();
        this.loadFonts();

        // Build the layout shell before any async work so the window is never blank.
        this.render();
        this.layout();
        this.showPage('home');
        this.applyAuthMode();
        window.addEventListener('resize', this._onResize);

        await this.resolveAccountVars();

        const configClient = await this.db.readData('configClient');
        const hasAccount = configClient && configClient.account_selected != null
            && await this.db.readData('accounts', configClient.account_selected);

        this.showPage(hasAccount ? 'home' : 'login');
        this.updateBoundVariables();
        this.refreshAllAccountLists();

        // Network-bound work (status ping, news) runs after first paint.
        this.refreshStatus().catch((e) => console.error('Studio status error', e));
    }

    /** Hides the login identifier/password fields when Microsoft auth is used. */
    applyAuthMode() {
        if (this.config.online !== true || !this.pageEls.login) return;
        this.pageEls.login.querySelectorAll('.srel-inner input').forEach((inp) => {
            const wrap = inp.closest('.srel');
            if (wrap) wrap.style.display = 'none';
        });
    }

    /* ------------------------------------------------------------------ */
    /* Layout & scaling                                                   */
    /* ------------------------------------------------------------------ */

    render() {
        const panels = document.querySelector('.panels');
        if (!panels) return;
        panels.innerHTML = '';
        this.pageEls = {};
        this.stages = [];
        this.bindings = [];
        this.serverStatusWidgets = [];
        this.accountLists = [];

        const stageW = (this.doc.stage && this.doc.stage.width) || 1920;
        const stageH = (this.doc.stage && this.doc.stage.height) || 1080;
        this.stageW = stageW;
        this.stageH = stageH;

        let statesCss = '';

        for (const pageId of PAGE_IDS) {
            const page = document.createElement('div');
            page.className = 'panel studio-page';
            page.dataset.page = pageId;
            page.style.overflow = 'hidden';

            const stage = document.createElement('div');
            stage.className = 'studio-stage';
            stage.style.position = 'absolute';
            stage.style.top = '0';
            stage.style.left = '0';
            stage.style.width = `${stageW}px`;
            stage.style.height = `${stageH}px`;
            stage.style.transformOrigin = 'top left';
            if (this.doc.stage && this.doc.stage.background) applyFill(stage, this.doc.stage.background);

            const elements = (this.doc.pages && this.doc.pages[pageId] && this.doc.pages[pageId].elements) || [];
            const sorted = [...elements].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
            for (const el of sorted) {
                const { outer, inner } = mountElement(el, { mode: 'launcher', vars: this.vars });
                stage.appendChild(outer);
                this.wireElement(el, inner, pageId);
            }

            statesCss += buildStatesStyleSheet(elements, `.studio-page[data-page="${pageId}"]`) + '\n';

            page.appendChild(stage);
            panels.appendChild(page);
            this.pageEls[pageId] = page;
            this.stages.push(stage);
        }

        const style = document.createElement('style');
        style.id = 'studio-states';
        style.textContent = statesCss;
        panels.appendChild(style);
    }

    layout() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        const s = Math.max(w / this.stageW, h / this.stageH); // cover
        const tx = (w - this.stageW * s) / 2;
        const ty = (h - this.stageH * s) / 2;
        for (const stage of this.stages) {
            stage.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
        }
    }

    showPage(id) {
        if (!this.pageEls[id]) id = 'home';
        this.current = id;
        for (const pid of PAGE_IDS) {
            this.pageEls[pid].classList.toggle('active', pid === id);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Element wiring                                                     */
    /* ------------------------------------------------------------------ */

    wireElement(el, inner, pageId) {
        // Track static elements that reference variables so we can refresh them.
        if (STATIC_BOUND_TYPES.has(el.type) && /\{[a-z_]+\}/i.test(`${el.content || ''}${el.src || ''}`)) {
            this.bindings.push({ el, inner });
        }

        // Dynamic widgets are filled with live data here.
        switch (el.type) {
            case 'server_status': this.mountServerStatus(inner, el); break;
            case 'news_feed': this.mountNewsFeed(inner, el); break;
            case 'social_links': this.mountSocialLinks(inner, el); break;
            case 'instance_select': this.mountInstanceSelect(inner, el); break;
            case 'account_list': this.mountAccountList(inner, el); break;
            default: break;
        }

        // Clickable actions (skip instance_select: it manages its own clicks).
        if (el.action && el.action !== 'none' && el.type !== 'instance_select') {
            inner.style.cursor = 'pointer';
            inner.addEventListener('click', () => this.handleAction(el));
        }
    }

    handleAction(el) {
        switch (el.action) {
            case 'launch_game': this.startGame(); break;
            case 'login': this.handleLogin(); break;
            case 'change_panel': this.showPage(el.actionTarget || 'home'); break;
            case 'open_url': if (el.actionTarget) shell.openExternal(el.actionTarget); break;
            case 'minimize_launcher': ipcRenderer.send('main-window-minimize'); break;
            case 'close_launcher': ipcRenderer.send('main-window-close'); break;
            case 'refresh_server': this.refreshStatus(); break;
            case 'logout': this.logout(); break;
            default: break;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Variables                                                          */
    /* ------------------------------------------------------------------ */

    async resolveAccountVars() {
        const configClient = await this.db.readData('configClient');
        const account = configClient && configClient.account_selected != null
            ? await this.db.readData('accounts', configClient.account_selected)
            : null;
        if (account) {
            this.vars['{player_username}'] = account.name || '';
            this.vars['{player_uuid}'] = account.uuid || '';
            this.vars['{player_avatar}'] = await this.avatarUrl(account);
        } else {
            this.vars['{player_username}'] = 'Invité';
            this.vars['{player_uuid}'] = '';
            this.vars['{player_avatar}'] = '';
        }
        this.vars['{ram_max}'] = String(configClient?.java_config?.java_memory?.max ?? '');
    }

    async avatarUrl(account) {
        try {
            const b64 = account?.profile?.skins?.[0]?.base64;
            if (b64) return await new skin2D().creatHeadTexture(b64);
        } catch (_) { /* ignore */ }
        if (account?.name) return `https://mc-heads.net/avatar/${encodeURIComponent(account.name)}/64`;
        return '';
    }

    /** Re-renders static elements that embed `{variables}` after a value change. */
    updateBoundVariables() {
        for (const b of this.bindings) {
            renderElementContent(b.inner, b.el, { mode: 'launcher', vars: this.vars });
        }
    }

    /* ------------------------------------------------------------------ */
    /* Server status                                                      */
    /* ------------------------------------------------------------------ */

    mountServerStatus(inner, el) {
        const accent = accentOf(el);
        inner.style.display = 'flex';
        inner.style.alignItems = 'center';
        inner.style.gap = '14px';
        inner.style.padding = '0 18px';
        inner.innerHTML =
            `<div class="ss-icon" style="background:${accent}22;color:${accent};"><img src="assets/images/icon/icon.png" onerror="this.style.display='none'"></div>` +
            `<div class="ss-main"><div class="ss-name"></div><div class="ss-state"></div></div>` +
            `<div class="ss-count" style="border-color:${accent}40;"><div class="ss-num">0</div><div class="ss-lbl">en ligne</div></div>`;
        this.serverStatusWidgets.push({
            name: inner.querySelector('.ss-name'),
            state: inner.querySelector('.ss-state'),
            num: inner.querySelector('.ss-num'),
        });
        this.updateServerStatusWidgets();
    }

    updateServerStatusWidgets() {
        const online = this.vars['{player_online}'];
        const ok = this.statusOk;
        const ms = this.statusMs || 0;
        for (const w of this.serverStatusWidgets) {
            if (w.name) w.name.textContent = this.vars['{server_name}'];
            if (w.state) {
                w.state.textContent = ok ? `● En ligne — ${ms} ms` : '● Hors ligne';
                w.state.style.color = ok ? '#1ac707' : '#ff4040';
            }
            if (w.num) w.num.textContent = online;
        }
    }

    async refreshStatus() {
        const configClient = await this.db.readData('configClient');
        let instances = await this.getInstances();
        const selected = instances.find((i) => i.name === configClient?.instance_select) || instances[0];

        this.vars['{server_name}'] = selected?.status?.nameServer || selected?.name || 'Serveur';

        let ok = false; let ms = 0; let online = '0'; let max = '—'; let statusText = 'Hors ligne';
        const ip = selected?.status?.ip;
        if (ip) {
            try {
                const st = await new Status(ip, selected.status.port).getStatus();
                if (st && !st.error) {
                    ok = true;
                    ms = st.ms || 0;
                    online = String(st.playersConnect ?? 0);
                    max = String(st.playersMax ?? st.players?.max ?? '—');
                    statusText = 'En ligne';
                }
            } catch (_) { /* offline */ }
        }
        this.statusOk = ok;
        this.statusMs = ms;
        this.vars['{player_online}'] = online;
        this.vars['{player_max}'] = max;
        this.vars['{server_status}'] = statusText;

        this.updateServerStatusWidgets();
        this.updateBoundVariables();
    }

    /* ------------------------------------------------------------------ */
    /* News feed                                                          */
    /* ------------------------------------------------------------------ */

    async mountNewsFeed(inner, el) {
        inner.style.display = 'block';
        inner.style.padding = '18px';
        inner.style.overflow = 'auto';
        inner.innerHTML = `<div class="studio-news-heading">Actualités</div><div class="studio-news-list studio-scroll">Chargement…</div>`;
        const list = inner.querySelector('.studio-news-list');
        try {
            const news = await config.getNews(this.config);
            list.innerHTML = '';
            if (!news || !news.length) {
                list.appendChild(this.newsCard({ title: 'Aucune actualité', content: "Aucune news n'est actuellement disponible.", author: 'Équipe', publish_date: new Date() }));
                return;
            }
            for (const n of news) list.appendChild(this.newsCard(n));
        } catch (error) {
            list.innerHTML = `<div class="studio-news-card">${escapeHtml(getErrorMessage(error, 'Impossible de charger les actualités.'))}</div>`;
        }
    }

    newsCard(n) {
        const d = this.getdate(n.publish_date);
        const card = document.createElement('div');
        card.className = 'studio-news-card';
        const body = escapeHtml(n.content || '').replace(/\n/g, '<br>');
        card.innerHTML =
            `<div class="studio-news-head"><div class="studio-news-title">${escapeHtml(n.title || 'Actualité')}</div>` +
            `<div class="studio-news-date"><span>${d.day}</span><span>${d.month}</span></div></div>` +
            `<div class="studio-news-body">${body}<div class="studio-news-author">Auteur — <b>${escapeHtml(n.author || 'Équipe')}</b></div></div>`;
        return card;
    }

    getdate(e) {
        const date = new Date(e);
        const months = ['JANV', 'FÉVR', 'MARS', 'AVR', 'MAI', 'JUIN', 'JUIL', 'AOÛT', 'SEPT', 'OCT', 'NOV', 'DÉC'];
        return { day: date.getDate(), month: months[date.getMonth()] || '' };
    }

    /* ------------------------------------------------------------------ */
    /* Social links                                                       */
    /* ------------------------------------------------------------------ */

    mountSocialLinks(inner, el) {
        inner.style.display = 'flex';
        inner.style.flexDirection = 'column';
        inner.style.alignItems = 'center';
        inner.style.gap = '14px';
        inner.style.overflow = 'auto';
        inner.style.padding = '8px';
        const links = this.config.socialLinks || [];
        inner.innerHTML = '';
        for (const s of links) {
            const b = document.createElement('div');
            b.className = 'social-block';
            b.innerHTML = `<div class="icon-${String(s.icon || 'link').toLowerCase()} icon-social"></div>`;
            b.addEventListener('click', () => { if (s.url) shell.openExternal(s.url); });
            inner.appendChild(b);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Instance selector / play button                                    */
    /* ------------------------------------------------------------------ */

    mountInstanceSelect(inner, el) {
        inner.style.display = 'flex';
        inner.style.alignItems = 'stretch';
        inner.style.padding = '0';
        inner.style.overflow = 'hidden';
        const label = applyVariables(el.content || 'Jouer', this.vars) || 'Jouer';
        inner.innerHTML =
            `<div class="studio-play-label">${escapeHtml(label)}</div>` +
            `<div class="studio-play-arrow">▾</div>`;
        const labelEl = inner.querySelector('.studio-play-label');
        const arrowEl = inner.querySelector('.studio-play-arrow');
        labelEl.style.cursor = 'pointer';
        arrowEl.style.cursor = 'pointer';
        labelEl.addEventListener('click', (e) => { e.stopPropagation(); this.startGame(); });
        arrowEl.addEventListener('click', (e) => { e.stopPropagation(); this.openInstancePicker(); });
    }

    async getInstances() {
        if (this.instances) return this.instances;
        try {
            this.instances = await config.getInstanceList();
        } catch (error) {
            console.error('Studio: unable to load instances', error);
            this.instances = [];
        }
        return this.instances;
    }

    async openInstancePicker() {
        const instances = await this.getInstances();
        if (!instances.length) return;
        const configClient = await this.db.readData('configClient');
        const auth = await this.db.readData('accounts', configClient?.account_selected);
        const visible = instances.filter((i) => !i.whitelistActive || (i.whitelist || []).includes(auth?.name));
        if (!visible.length) return;

        const overlay = document.createElement('div');
        overlay.className = 'studio-overlay';
        const box = document.createElement('div');
        box.className = 'studio-overlay-box';
        box.innerHTML = `<div class="studio-overlay-title">Choisis ton instance</div>`;
        const listWrap = document.createElement('div');
        listWrap.className = 'studio-overlay-list';
        for (const i of visible) {
            const item = document.createElement('div');
            item.className = 'studio-overlay-item' + (i.name === configClient?.instance_select ? ' is-active' : '');
            item.textContent = i.name;
            item.addEventListener('click', async () => {
                const cc = await this.db.readData('configClient');
                cc.instance_select = i.name;
                await this.db.updateData('configClient', cc);
                overlay.remove();
                this.refreshStatus();
            });
            listWrap.appendChild(item);
        }
        box.appendChild(listWrap);
        const close = document.createElement('button');
        close.className = 'studio-overlay-close';
        close.textContent = 'Fermer';
        close.addEventListener('click', () => overlay.remove());
        box.appendChild(close);
        overlay.appendChild(box);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.querySelector('.panels').appendChild(overlay);
    }

    /* ------------------------------------------------------------------ */
    /* Account manager                                                    */
    /* ------------------------------------------------------------------ */

    mountAccountList(inner, el) {
        this.accountLists.push({ inner, el });
        this.refreshAccountList(inner, el);
    }

    refreshAllAccountLists() {
        for (const a of this.accountLists) this.refreshAccountList(a.inner, a.el);
    }

    async refreshAccountList(inner, el) {
        const accent = accentOf(el);
        const accounts = await this.db.readAllData('accounts');
        const configClient = await this.db.readData('configClient');
        const selectedId = configClient?.account_selected;
        inner.innerHTML = '';

        for (const acc of accounts) {
            const row = document.createElement('div');
            row.className = 'studio-account-row' + (acc.ID === selectedId ? ' is-active' : '');
            if (acc.ID === selectedId) row.style.borderColor = `${accent}66`;
            const av = await this.avatarUrl(acc);
            row.innerHTML =
                `<div class="studio-account-av" style="background-image:url('${av}')"></div>` +
                `<div class="studio-account-main"><div class="studio-account-name">${escapeHtml(acc.name || '')}</div>` +
                `<div class="studio-account-uuid">${escapeHtml(acc.uuid || '')}</div></div>` +
                `<div class="studio-account-del" title="Supprimer">✕</div>`;
            row.addEventListener('click', (e) => {
                if (e.target.classList.contains('studio-account-del')) { e.stopPropagation(); this.deleteAccount(acc); return; }
                this.selectAccount(acc);
            });
            inner.appendChild(row);
        }

        const add = document.createElement('div');
        add.className = 'studio-account-add';
        add.style.borderColor = `${accent}55`;
        add.style.color = accent;
        add.textContent = '+ Ajouter un compte';
        add.addEventListener('click', () => this.showPage('login'));
        inner.appendChild(add);
    }

    async selectAccount(acc) {
        const configClient = await this.db.readData('configClient');
        configClient.account_selected = acc.ID;
        await this.db.updateData('configClient', configClient);
        await this.resolveAccountVars();
        this.updateBoundVariables();
        this.refreshAllAccountLists();
        this.refreshStatus();
    }

    async deleteAccount(acc) {
        await this.db.deleteData('accounts', acc.ID);
        const configClient = await this.db.readData('configClient');
        if (configClient?.account_selected === acc.ID) {
            configClient.account_selected = null;
            await this.db.updateData('configClient', configClient);
            await this.resolveAccountVars();
            this.updateBoundVariables();
        }
        this.refreshAllAccountLists();
    }

    async logout() {
        const configClient = await this.db.readData('configClient');
        const id = configClient?.account_selected;
        if (id != null) await this.db.deleteData('accounts', id).catch(() => {});
        if (configClient) { configClient.account_selected = null; await this.db.updateData('configClient', configClient); }
        await this.resolveAccountVars();
        this.updateBoundVariables();
        this.refreshAllAccountLists();
        this.showPage('login');
    }

    /* ------------------------------------------------------------------ */
    /* Login flows                                                        */
    /* ------------------------------------------------------------------ */

    loginInputValue(index) {
        const page = this.pageEls.login;
        const inputs = page ? page.querySelectorAll('input') : [];
        return inputs[index] ? inputs[index].value.trim() : '';
    }

    popupError(message) {
        new popup().openPopup({ title: 'Erreur', content: message, options: true });
    }

    handleLogin() {
        const online = this.config.online;
        if (online === false) return this.loginOffline();
        if (typeof online === 'string' && /^https?:\/\//.test(online)) return this.loginAZauth(online);
        return this.loginMicrosoft();
    }

    loginMicrosoft() {
        const p = new popup();
        p.openPopup({ title: 'Connexion', content: 'Veuillez patienter...', color: 'var(--color)' });
        ipcRenderer.invoke('Microsoft-window', this.config.client_id).then(async (acc) => {
            if (!acc || acc === 'cancel') { p.closePopup(); return; }
            await this.saveAccount(acc);
            p.closePopup();
        }).catch((err) => {
            p.openPopup({ title: 'Erreur', content: getErrorMessage(err, 'La connexion Microsoft a échoué.'), options: true });
        });
    }

    async loginOffline() {
        const pseudo = this.loginInputValue(0);
        if (!pseudo || pseudo.length < 3) return this.popupError('Votre pseudo doit faire au moins 3 caractères.');
        if (/ /.test(pseudo)) return this.popupError("Votre pseudo ne doit pas contenir d'espaces.");
        const res = await Mojang.login(pseudo);
        if (res.error) return this.popupError(res.message);
        await this.saveAccount(res);
    }

    async loginAZauth(url) {
        const email = this.loginInputValue(0);
        const password = this.loginInputValue(1);
        if (!email || !password) return this.popupError('Veuillez remplir tous les champs.');
        const client = new AZauth(url);
        const p = new popup();
        p.openPopup({ title: 'Connexion en cours...', content: 'Veuillez patienter...', color: 'var(--color)' });
        let res = await client.login(email, password);
        if (res.error) { p.closePopup(); return this.popupError(res.message); }
        if (res.A2F) {
            p.closePopup();
            const code = await this.promptA2F();
            if (!code) return;
            res = await client.login(email, password, code);
            if (res.error) return this.popupError(res.message);
        }
        await this.saveAccount(res);
        p.closePopup();
    }

    /** Lightweight A2F prompt (the Studio login page has no dedicated field). */
    promptA2F() {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'studio-overlay';
            overlay.innerHTML =
                `<div class="studio-overlay-box"><div class="studio-overlay-title">Code de sécurité (A2F)</div>` +
                `<input type="text" class="studio-a2f-input" placeholder="Code" autofocus>` +
                `<div class="studio-overlay-actions"><button class="studio-overlay-close studio-a2f-cancel">Annuler</button>` +
                `<button class="studio-overlay-ok studio-a2f-ok">Valider</button></div></div>`;
            const input = overlay.querySelector('.studio-a2f-input');
            const done = (v) => { overlay.remove(); resolve(v); };
            overlay.querySelector('.studio-a2f-ok').addEventListener('click', () => done(input.value.trim() || null));
            overlay.querySelector('.studio-a2f-cancel').addEventListener('click', () => done(null));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
            document.querySelector('.panels').appendChild(overlay);
            setTimeout(() => input.focus(), 50);
        });
    }

    async saveAccount(data) {
        const configClient = await this.db.readData('configClient');
        const account = await this.db.createData('accounts', data);
        configClient.account_selected = account.ID;
        await this.db.updateData('configClient', configClient);
        await this.resolveAccountVars();
        this.updateBoundVariables();
        this.refreshAllAccountLists();
        await this.refreshStatus();
        this.showPage('home');
    }

    /* ------------------------------------------------------------------ */
    /* Game launch                                                        */
    /* ------------------------------------------------------------------ */

    async startGame() {
        if (this.launching) return;
        const configClient = await this.db.readData('configClient');
        const account = configClient && configClient.account_selected != null
            ? await this.db.readData('accounts', configClient.account_selected)
            : null;
        if (!account) return this.showPage('login');

        let instances;
        try {
            instances = await config.getInstanceList();
            this.instances = instances;
        } catch (error) {
            return this.popupError(getErrorMessage(error, 'Impossible de récupérer la liste des instances.'));
        }
        const options = instances.find((i) => i.name === configClient.instance_select) || instances[0];
        if (!options) return this.popupError('Aucune instance disponible.');

        this.launching = true;
        this.setDownload(0, 0);

        const path = `${await appdata()}/${process.platform === 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}`;

        const launch = new Launch();
        const opt = {
            url: options.url,
            authenticator: account,
            timeout: 10000,
            path,
            instance: options.name,
            version: options.loader.minecraft_version,
            detached: configClient.launcher_config.closeLauncher === 'close-all' ? false : true,
            downloadFileMultiple: configClient.launcher_config.download_multi,
            intelEnabledMac: configClient.launcher_config.intelEnabledMac,
            loader: {
                type: options.loader.loader_type,
                build: options.loader.loader_version,
                enable: options.loader.loader_type === 'none' ? false : true,
            },
            verify: options.verify,
            ignored: [...options.ignored],
            java: { path: configClient.java_config.java_path },
            JVM_ARGS: options.jvm_args ? options.jvm_args : [],
            GAME_ARGS: options.game_args ? options.game_args : [],
            screen: {
                width: configClient.game_config.screen_size.width,
                height: configClient.game_config.screen_size.height,
            },
            memory: {
                min: `${configClient.java_config.java_memory.min * 1024}M`,
                max: `${configClient.java_config.java_memory.max * 1024}M`,
            },
        };

        launch.Launch(opt);
        ipcRenderer.send('main-window-progress-load');

        launch.on('progress', (progress, size) => this.setDownload(progress, size));
        launch.on('check', (progress, size) => this.setDownload(progress, size));
        launch.on('patch', () => ipcRenderer.send('main-window-progress-load'));
        launch.on('data', () => {
            if (configClient.launcher_config.closeLauncher === 'close-launcher') ipcRenderer.send('main-window-hide');
            ipcRenderer.send('main-window-progress-load');
        });
        launch.on('close', () => {
            if (configClient.launcher_config.closeLauncher === 'close-launcher') ipcRenderer.send('main-window-show');
            ipcRenderer.send('main-window-progress-reset');
            this.launching = false;
            this.setDownload(0, 0);
        });
        launch.on('error', (err) => {
            if (configClient.launcher_config.closeLauncher === 'close-launcher') ipcRenderer.send('main-window-show');
            ipcRenderer.send('main-window-progress-reset');
            this.launching = false;
            this.setDownload(0, 0);
            this.popupError(getErrorMessage(err, "Le jeu n'a pas pu être lancé."));
        });
    }

    setDownload(progress, size) {
        const pct = size ? Math.min(100, Math.round((progress / size) * 100)) : 0;
        this.vars['{download_percentage}'] = String(pct);
        if (size) ipcRenderer.send('main-window-progress', { progress, size });
        this.updateBoundVariables();
    }

    /* ------------------------------------------------------------------ */
    /* Assets                                                             */
    /* ------------------------------------------------------------------ */

    loadFonts() {
        const fonts = (this.doc && this.doc.fonts) || [];
        if (!fonts.length) return;
        const families = fonts.map((f) => `family=${encodeURIComponent(f)}:wght@300;400;500;600;700;800`).join('&');
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
        document.head.appendChild(link);
    }

    injectRuntimeCss() {
        if (document.getElementById('studio-runtime-css')) return;
        const style = document.createElement('style');
        style.id = 'studio-runtime-css';
        style.textContent = STUDIO_RUNTIME_CSS;
        document.head.appendChild(style);
    }
}

const STUDIO_RUNTIME_CSS = `
.studio-page { position: absolute; inset: 0; }
.studio-stage img { -webkit-user-drag: none; }
.studio-scroll::-webkit-scrollbar { width: 0; }

.ss-icon { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; width: 52px; height: 52px; border-radius: 12px; overflow: hidden; }
.ss-icon img { width: 70%; height: 70%; object-fit: contain; }
.ss-main { flex: 1 1 auto; min-width: 0; }
.ss-name { font-size: 1.25em; font-weight: 700; color: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ss-state { font-size: 0.7em; font-weight: 500; color: #1ac707; margin-top: 2px; }
.ss-count { flex: 0 0 auto; text-align: center; padding: 4px 14px; border: 1px solid; border-radius: 10px; }
.ss-num { font-size: 1.3em; font-weight: 800; color: inherit; line-height: 1; }
.ss-lbl { font-size: 0.6em; opacity: 0.6; }

.studio-news-heading { font-size: 1.4em; font-weight: 700; color: inherit; margin-bottom: 14px; }
.studio-news-list { display: flex; flex-direction: column; gap: 12px; }
.studio-news-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; padding: 14px 16px; }
.studio-news-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.studio-news-title { font-size: 1.05em; font-weight: 600; color: inherit; }
.studio-news-date { display: flex; flex-direction: column; align-items: center; line-height: 1; opacity: 0.7; font-size: 0.7em; }
.studio-news-date span:first-child { font-size: 1.5em; font-weight: 800; }
.studio-news-body { font-size: 0.82em; font-weight: 300; opacity: 0.85; margin-top: 8px; }
.studio-news-author { margin-top: 10px; text-align: right; font-size: 0.85em; opacity: 0.7; }

.studio-play-label { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; color: inherit; font: inherit; letter-spacing: inherit; }
.studio-play-arrow { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; width: 48px; border-left: 2px solid currentColor; color: inherit; opacity: 0.85; font-size: 1.4em; }

.studio-account-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07); cursor: pointer; }
.studio-account-row.is-active { background: rgba(34,197,94,0.08); }
.studio-account-av { flex: 0 0 auto; width: 42px; height: 42px; border-radius: 10px; background: #222a33 center/cover no-repeat; image-rendering: pixelated; }
.studio-account-main { flex: 1 1 auto; min-width: 0; }
.studio-account-name { font-weight: 700; color: inherit; }
.studio-account-uuid { font-size: 0.7em; opacity: 0.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.studio-account-del { flex: 0 0 auto; opacity: 0.5; cursor: pointer; padding: 0 6px; }
.studio-account-del:hover { opacity: 1; color: #ff4040; }
.studio-account-add { display: flex; align-items: center; justify-content: center; padding: 10px; border: 1px dashed; border-radius: 12px; font-weight: 600; font-size: 0.9em; margin-top: 2px; cursor: pointer; }

.studio-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 9; }
.studio-overlay-box { background: var(--background, #1c2128); color: var(--color, #f5f5f5); border-radius: 16px; padding: 22px; min-width: 360px; max-width: 70%; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
.studio-overlay-title { font-size: 1.3em; font-weight: 800; margin-bottom: 14px; text-align: center; }
.studio-overlay-list { display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow: auto; }
.studio-overlay-item { padding: 12px 16px; border-radius: 10px; background: rgba(255,255,255,0.05); cursor: pointer; font-weight: 600; }
.studio-overlay-item:hover, .studio-overlay-item.is-active { background: rgba(34,197,94,0.18); }
.studio-overlay-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.studio-a2f-input { width: 100%; margin-top: 6px; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; font: inherit; box-sizing: border-box; }
.studio-overlay-close, .studio-overlay-ok { margin-top: 16px; padding: 10px 20px; border: 0; border-radius: 10px; font-weight: 700; cursor: pointer; }
.studio-overlay-close { background: rgba(255,255,255,0.1); color: inherit; }
.studio-overlay-ok { background: #22c55e; color: #04140a; }
`;
