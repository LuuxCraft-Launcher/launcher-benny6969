/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
// import panel
import Login from './panels/login.js';
import Home from './panels/home.js';
import Settings from './panels/settings.js';
import StudioEngine from './studio/engine.js';

// import modules
import { logger, config, changePanel, database, popup, setBackground, accountSelect, addAccount, pkg, getErrorCode, getErrorMessage, normalizeError } from './utils.js';
const { AZauth, Microsoft, Mojang } = require('minecraft-java-core');

// libs
const { ipcRenderer } = require('electron');
const fs = require('fs');
const os = require('os');

class Launcher {
    async init() {
        this.initLog();
        console.log('Initializing Launcher...');
        this.shortcut()
        await setBackground()
        this.initFrame();
        this.db = new database();

        try {
            this.config = await config.GetConfig();
            await this.db.initDefaultData();
            await this.initConfigClient();

            if (this.config && this.config.studio) {
                // Studio Pro layout from the panel fully replaces the native panels.
                // The studio renders its own window controls, so hide the native frame.
                console.log('Initializing Studio layout...');
                document.querySelectorAll('.frame').forEach(f => f.classList.remove('hide'));
                this.studio = new StudioEngine(this.config);
                await this.studio.init();
            } else {
                this.createPanels(Login, Home, Settings);
                await this.startLauncher();
            }
        } catch (error) {
            this.configError = normalizeError(error, {
                code: 'CONFIG_ERROR',
                message: 'Impossible de demarrer le launcher.'
            });
            console.error('Launcher initialization failed', this.configError);
            return this.errorConnect();
        }
    }

    initLog() {
        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.shiftKey && e.keyCode == 73 || e.keyCode == 123) {
                ipcRenderer.send('main-window-dev-tools-close');
                ipcRenderer.send('main-window-dev-tools');
            }
        })
        new logger(pkg.name, '#7289da')
    }

    shortcut() {
        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.keyCode == 87) {
                ipcRenderer.send('main-window-close');
            }
        })
    }


    errorConnect() {
        new popup().openPopup({
            title: getErrorCode(this.configError, 'CONNEXION'),
            content: getErrorMessage(this.configError, 'Impossible de contacter le serveur.'),
            color: 'red',
            exit: true,
            options: true
        });
    }

    initFrame() {
        console.log('Initializing Frame...')
        const platform = os.platform() === 'darwin' ? "darwin" : "other";

        document.querySelector(`.${platform} .frame`).classList.toggle('hide')

        document.querySelector(`.${platform} .frame #minimize`).addEventListener('click', () => {
            ipcRenderer.send('main-window-minimize');
        });

        let maximized = false;
        let maximize = document.querySelector(`.${platform} .frame #maximize`);
        maximize.addEventListener('click', () => {
            if (maximized) ipcRenderer.send('main-window-maximize')
            else ipcRenderer.send('main-window-maximize');
            maximized = !maximized
            maximize.classList.toggle('icon-maximize')
            maximize.classList.toggle('icon-restore-down')
        });

        document.querySelector(`.${platform} .frame #close`).addEventListener('click', () => {
            ipcRenderer.send('main-window-close');
        })
    }

    async initConfigClient() {
        console.log('Initializing Config Client...')
        let configClient = await this.db.readData('configClient')

        let defaultConfig = {
            account_selected: null,
            instance_select: null,
            java_config: {
                java_path: null,
                java_memory: {
                    min: 2,
                    max: 4
                }
            },
            game_config: {
                screen_size: {
                    width: 854,
                    height: 480
                }
            },
            launcher_config: {
                download_multi: 5,
                theme: 'auto',
                closeLauncher: 'close-launcher',
                intelEnabledMac: true
            }
        }

        if (!configClient) await this.db.createData('configClient', defaultConfig)


        let needUpdate = false

        function deepMerge(target, defaults) {
            for (let key in defaults) {
                if (!(key in target)) {
                    target[key] = defaults[key]
                    needUpdate = true
                } else if (defaults[key] !== null && typeof defaults[key] === 'object' && !Array.isArray(defaults[key]) && target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key])) {
                    deepMerge(target[key], defaults[key])
                }
            }
        }
        deepMerge(configClient, defaultConfig)

        if (needUpdate) await this.db.updateData('configClient', configClient)
    }

    createPanels(...panels) {
        let panelsElem = document.querySelector('.panels')
        for (let panel of panels) {
            console.log(`Initializing ${panel.name} Panel...`);
            let div = document.createElement('div');
            div.classList.add('panel', panel.id)
            div.innerHTML = fs.readFileSync(`${__dirname}/panels/${panel.id}.html`, 'utf8');
            panelsElem.appendChild(div);
            new panel().init(this.config);
        }
    }

    async startLauncher() {
        let accounts = await this.db.readAllData('accounts')
        let configClient = await this.db.readData('configClient')
        let account_selected = configClient ? configClient.account_selected : null
        let popupRefresh = new popup();
        let refreshedAccounts = [];
        let refreshErrors = [];

        if (accounts?.length) {
            for (let account of accounts) {
                let account_ID = account.ID
                if (account.error) {
                    await this.db.deleteData('accounts', account_ID)
                    continue
                }
                popupRefresh.openPopup({
                    title: 'Connexion',
                    content: `Verification du compte ${account.name}...`,
                    color: 'var(--color)',
                    background: false
                });

                const refreshResult = await this.refreshAccount(account);

                if (!refreshResult.success) {
                    refreshErrors.push(refreshResult.error);
                    if (account_ID == account_selected) {
                        configClient.account_selected = null
                        await this.db.updateData('configClient', configClient)
                    }
                    console.error(`[Account] ${account.name}:`, refreshResult.error);
                    continue;
                }

                refreshedAccounts.push(refreshResult.account);
                await addAccount(refreshResult.account)
                if (account_ID == account_selected) accountSelect(refreshResult.account)
            }

            accounts = refreshedAccounts
            configClient = await this.db.readData('configClient')
            account_selected = configClient ? configClient.account_selected : null

            if (!account_selected) {
                let firstAccount = accounts[0]
                if (firstAccount?.ID) {
                    configClient.account_selected = firstAccount.ID
                    await this.db.updateData('configClient', configClient)
                    accountSelect(firstAccount)
                }
            }

            if (!accounts.length) {
                configClient.account_selected = null
                await this.db.updateData('configClient', configClient);
                popupRefresh.closePopup()
                if (refreshErrors.length) {
                    const firstError = refreshErrors[0];
                    new popup().openPopup({
                        title: 'Connexion requise',
                        content: `${getErrorMessage(firstError, 'Aucun compte n a pu etre rafraichi.')}<br>Veuillez vous reconnecter.`,
                        color: 'red',
                        options: true
                    });
                }
                return changePanel("login");
            }

            popupRefresh.closePopup()
            changePanel("home");
        } else {
            popupRefresh.closePopup()
            changePanel('login');
        }
    }

    async refreshAccount(account) {
        const account_ID = account.ID;

        try {
            if (account.meta.type === 'Xbox') {
                let refreshAccount = await new Microsoft(this.config.client_id).refresh(account);

                if (refreshAccount.error) {
                    throw new Error(refreshAccount.errorMessage || 'Echec du rafraichissement Microsoft.');
                }

                refreshAccount.ID = account_ID;
                await this.db.updateData('accounts', refreshAccount, account_ID);
                return { success: true, account: refreshAccount };
            }

            if (account.meta.type === 'AZauth') {
                let refreshAccount = await new AZauth(this.config.online).verify(account);

                if (refreshAccount.error) {
                    throw new Error(refreshAccount.message || 'Echec du rafraichissement AZauth.');
                }

                refreshAccount.ID = account_ID;
                await this.db.updateData('accounts', refreshAccount, account_ID);
                return { success: true, account: refreshAccount };
            }

            if (account.meta.type === 'Mojang') {
                let refreshAccount = account.meta.online == false
                    ? await Mojang.login(account.name)
                    : await Mojang.refresh(account);

                if (refreshAccount.error) {
                    throw new Error(refreshAccount.errorMessage || refreshAccount.message || 'Echec du rafraichissement Mojang.');
                }

                refreshAccount.ID = account_ID;
                await this.db.updateData('accounts', refreshAccount, account_ID);
                return { success: true, account: refreshAccount };
            }

            throw new Error('Type de compte inconnu.');
        } catch (error) {
            return {
                success: false,
                error: normalizeError(error, {
                    code: 'ACCOUNT_REFRESH_ERROR',
                    message: `Impossible de rafraichir le compte ${account.name}.`
                })
            };
        }
    }
}

new Launcher().init();
