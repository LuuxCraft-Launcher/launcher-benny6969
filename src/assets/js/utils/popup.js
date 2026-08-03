/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { ipcRenderer } = require('electron');

export default class popup {
    constructor() {
        this.popup = document.querySelector('.popup');
        this.popupTitle = document.querySelector('.popup-title');
        this.popupContent = document.querySelector('.popup-content');
        this.popupOptions = document.querySelector('.popup-options');
        this.popupButton = document.querySelector('.popup-button');
    }

    openPopup(info) {
        this.popup.style.display = 'flex';
        if (info.background == false) this.popup.style.background = 'none';
        else this.popup.style.background = '#000000b3'
        this.popupTitle.innerHTML = info.title;
        this.popupContent.style.color = info.color ? info.color : '#e21212';
        this.popupContent.innerHTML = info.content;
        this.popupButton.onclick = null;

        this.popupOptions.style.display = info.options ? 'flex' : 'none';

        if (info.options) {
            this.popupButton.onclick = () => {
                if (info.exit) return ipcRenderer.send('main-window-close');
                this.closePopup();
            };
        }
    }

    closePopup() {
        this.popup.style.display = 'none';
        this.popupTitle.innerHTML = '';
        this.popupContent.innerHTML = '';
        this.popupOptions.style.display = 'none';
        this.popupButton.onclick = null;
    }
}