/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 *
 * LuuxCraft Studio — launcher-side render mirror.
 *
 * This is a faithful port of the panel editor's pure render helpers
 * (LuuxCraftPanel/public/js/studio/render.js). Keeping the compilation logic
 * identical guarantees the shipped launcher is pixel-faithful to the Studio Pro
 * preview. Static element content is rendered here; dynamic elements
 * (server_status, news_feed, social_links, instance_select, account_list) are
 * left empty on purpose and filled with live data by the StudioEngine.
 */

const DYNAMIC_TYPES = new Set(['server_status', 'news_feed', 'social_links', 'instance_select', 'account_list']);

export function isDynamicType(type) {
    return DYNAMIC_TYPES.has(type);
}

/** Replaces `{token}` occurrences using a `{token} -> value` map. */
export function applyVariables(text, vars) {
    if (!text) return '';
    return String(text).replace(/\{[a-z_]+\}/gi, (m) => (vars && m in vars ? vars[m] : m));
}

/* ---------------- fill ---------------- */

function stopsToCss(stops) {
    return (stops || []).map((s) => `${s.color} ${s.offset}%`).join(', ');
}

export function cssFillValue(fill) {
    if (!fill || fill.type === 'none') return null;
    if (fill.type === 'solid') return fill.color;
    if (fill.type === 'linear') return `linear-gradient(${fill.angle}deg, ${stopsToCss(fill.stops)})`;
    if (fill.type === 'radial') return `radial-gradient(${fill.shape || 'circle'}, ${stopsToCss(fill.stops)})`;
    return null;
}

export function applyFill(node, fill) {
    node.style.background = '';
    node.style.backgroundImage = '';
    node.style.backgroundSize = '';
    node.style.backgroundPosition = '';
    node.style.backgroundRepeat = '';
    if (!fill || fill.type === 'none') {
        node.style.background = 'transparent';
        return;
    }
    if (fill.type === 'image') {
        node.style.backgroundImage = `url("${fill.url}")`;
        node.style.backgroundSize = fill.size || 'cover';
        node.style.backgroundPosition = fill.position || 'center';
        node.style.backgroundRepeat = 'no-repeat';
        return;
    }
    const value = cssFillValue(fill);
    if (value) node.style.background = value;
}

/* ---------------- geometry-ish ---------------- */

export function radiusToCss(r) {
    if (!r) return '0';
    return `${r.tl || 0}px ${r.tr || 0}px ${r.br || 0}px ${r.bl || 0}px`;
}

export function borderToCss(border) {
    if (!border || !border.width || border.style === 'none') return 'none';
    return `${border.width}px ${border.style} ${border.color}`;
}

export function shadowsToCss(shadows) {
    if (!shadows || !shadows.length) return 'none';
    return shadows
        .map((s) => `${s.inset ? 'inset ' : ''}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`)
        .join(', ');
}

export function applyTypography(node, t) {
    if (!t) return;
    if (t.fontFamily) node.style.fontFamily = `"${t.fontFamily}", Poppins, Inter, system-ui, sans-serif`;
    if (t.fontSize != null) node.style.fontSize = `${t.fontSize}px`;
    if (t.fontWeight != null) node.style.fontWeight = String(t.fontWeight);
    if (t.fontStyle) node.style.fontStyle = t.fontStyle;
    if (t.color) node.style.color = t.color;
    if (t.letterSpacing != null) node.style.letterSpacing = `${t.letterSpacing}px`;
    if (t.lineHeight != null) node.style.lineHeight = String(t.lineHeight);
    if (t.textAlign) node.style.textAlign = t.textAlign;
    if (t.textTransform) node.style.textTransform = t.textTransform;
    node.style.textShadow = t.textShadow
        ? `${t.textShadow.x}px ${t.textShadow.y}px ${t.textShadow.blur}px ${t.textShadow.color}`
        : 'none';
}

export function applyBaseStyle(node, el) {
    const s = el.style;
    applyFill(node, s.fill);
    node.style.opacity = String(s.opacity != null ? s.opacity : 1);
    node.style.borderRadius = radiusToCss(s.radius);
    node.style.border = borderToCss(s.border);
    node.style.boxShadow = shadowsToCss(s.shadows);
    if (s.backdropBlur > 0) {
        node.style.backdropFilter = `blur(${s.backdropBlur}px)`;
        node.style.webkitBackdropFilter = `blur(${s.backdropBlur}px)`;
    } else {
        node.style.backdropFilter = '';
        node.style.webkitBackdropFilter = '';
    }
    applyTypography(node, s.typography);
}

export function applyContentAlignment(node, t) {
    const align = t && t.textAlign ? t.textAlign : 'left';
    node.style.display = 'flex';
    node.style.alignItems = 'center';
    node.style.justifyContent =
        align === 'center' ? 'center' : align === 'right' ? 'flex-end' : align === 'justify' ? 'space-between' : 'flex-start';
}

/* ---------------- content rendering (static types only) ---------------- */

function parsePercent(value, vars) {
    const resolved = applyVariables(value, vars);
    const n = parseFloat(String(resolved).replace('%', ''));
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

export function renderElementContent(node, el, opts = {}) {
    const vars = opts.vars || {};
    node.innerHTML = '';

    // Dynamic elements are filled by the engine after mount.
    if (isDynamicType(el.type)) return;

    if (el.type === 'image') {
        const url = applyVariables(el.src, vars);
        if (url && url.indexOf('{') === -1) {
            const img = document.createElement('img');
            img.className = 'studio-el-img';
            img.src = url;
            img.draggable = false;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = el.style.fill && el.style.fill.type === 'image' ? 'cover' : 'contain';
            img.onerror = () => { node.innerHTML = ''; };
            node.appendChild(img);
        }
        return;
    }

    if (el.type === 'progressbar') {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden;border-radius:inherit;';
        const fill = document.createElement('div');
        fill.className = 'studio-el-progress-fill';
        fill.style.cssText = 'position:absolute;inset:0 auto 0 0;border-radius:inherit;background:linear-gradient(90deg,#22c55e,#22d3ee);';
        const pct = parsePercent(el.content || '{download_percentage}', vars);
        fill.style.width = `${pct}%`;
        wrap.appendChild(fill);
        node.appendChild(wrap);
        return;
    }

    if (el.type === 'input_text') {
        const input = document.createElement('input');
        input.type = el.placeholder && /pass|mot de passe/i.test(el.placeholder) ? 'password' : 'text';
        input.placeholder = el.placeholder || '';
        input.value = applyVariables(el.content, vars);
        input.style.cssText =
            'width:100%;height:100%;background:transparent;border:0;outline:none;color:inherit;font:inherit;text-align:inherit;padding:0 14px;box-sizing:border-box;';
        node.appendChild(input);
        return;
    }

    if (el.type === 'webview') {
        const wv = document.createElement('webview');
        wv.setAttribute('src', el.src || 'about:blank');
        wv.style.cssText = 'width:100%;height:100%;border:0;';
        node.appendChild(wv);
        return;
    }

    if (el.type === 'text' || el.type === 'button') {
        applyContentAlignment(node, el.style.typography);
        node.style.padding = el.type === 'button' ? '0 14px' : '0';
        const span = document.createElement('span');
        span.style.width = '100%';
        span.style.textAlign = (el.style.typography && el.style.typography.textAlign) || 'left';
        span.textContent = applyVariables(el.content || '', vars);
        node.appendChild(span);
        return;
    }
    // rectangle: pure container.
}

/* ---------------- state (hover/active) CSS ---------------- */

export function stateStyleToDeclarations(state) {
    if (!state) return '';
    const out = [];
    if (state.fill) {
        if (state.fill.type === 'image') {
            out.push(`background-image: url("${state.fill.url}")`);
            out.push(`background-size: ${state.fill.size || 'cover'}`);
            out.push(`background-position: ${state.fill.position || 'center'}`);
        } else {
            const v = cssFillValue(state.fill);
            if (v) out.push(`background: ${v}`);
            else if (state.fill.type === 'none') out.push('background: transparent');
        }
    }
    if (state.opacity != null) out.push(`opacity: ${state.opacity}`);
    if (state.radius) out.push(`border-radius: ${radiusToCss(state.radius)}`);
    if (state.border) out.push(`border: ${borderToCss(state.border)}`);
    if (state.shadows) out.push(`box-shadow: ${shadowsToCss(state.shadows)}`);
    if (state.backdropBlur != null) {
        out.push(`backdrop-filter: blur(${state.backdropBlur}px)`);
        out.push(`-webkit-backdrop-filter: blur(${state.backdropBlur}px)`);
    }
    if (state.typography) {
        const t = state.typography;
        if (t.color) out.push(`color: ${t.color}`);
        if (t.fontSize != null) out.push(`font-size: ${t.fontSize}px`);
        if (t.fontWeight != null) out.push(`font-weight: ${t.fontWeight}`);
        if (t.letterSpacing != null) out.push(`letter-spacing: ${t.letterSpacing}px`);
    }

    const transforms = [];
    if (state.translateX != null || state.translateY != null) {
        transforms.push(`translate(${state.translateX || 0}px, ${state.translateY || 0}px)`);
    }
    if (state.scale != null) transforms.push(`scale(${state.scale})`);
    if (state.rotate != null) transforms.push(`rotate(${state.rotate}deg)`);
    if (transforms.length) out.push(`transform: ${transforms.join(' ')} !important`);

    return out.join('; ');
}

export function buildElementStateCss(el, selector) {
    const rules = [];
    const tr = el.transition || { duration: 200, timing: 'ease-in-out' };
    rules.push(`${selector}{transition:all ${tr.duration}ms ${tr.timing};}`);

    const hover = stateStyleToDeclarations(el.states && el.states.hover);
    if (hover) rules.push(`${selector}:hover{${hover};}`);

    const active = stateStyleToDeclarations(el.states && el.states.active);
    if (active) rules.push(`${selector}:active{${active};}`);

    return rules.join('\n');
}

/**
 * Mounts one element as an outer (geometry + rotation) wrapper containing an
 * inner node (visual style + content). Identical split to the editor so
 * hover/active transforms compose with the base rotation.
 */
export function mountElement(element, opts = {}) {
    const outer = document.createElement('div');
    outer.className = 'srel';
    outer.dataset.id = element.id;
    outer.style.position = 'absolute';
    outer.style.left = `${element.x}px`;
    outer.style.top = `${element.y}px`;
    outer.style.width = `${element.width}px`;
    outer.style.height = `${element.height}px`;
    outer.style.zIndex = String(element.zIndex);
    outer.style.transformOrigin = 'center center';
    if (element.rotation) outer.style.transform = `rotate(${element.rotation}deg)`;
    if (element.hidden) outer.style.display = 'none';

    const inner = document.createElement('div');
    inner.className = 'srel-inner';
    inner.style.width = '100%';
    inner.style.height = '100%';
    inner.style.boxSizing = 'border-box';
    inner.style.overflow = 'hidden';
    inner.style.display = 'flex';
    applyBaseStyle(inner, element);
    renderElementContent(inner, element, opts);

    outer.appendChild(inner);
    return { outer, inner };
}

export function buildStatesStyleSheet(elements, prefix) {
    return (elements || [])
        .map((el) => buildElementStateCss(el, `${prefix} [data-id="${el.id}"] .srel-inner`))
        .join('\n');
}
