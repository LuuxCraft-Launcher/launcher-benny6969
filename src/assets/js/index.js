/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { ipcRenderer, shell } = require('electron');
const pkg = require('../package.json');
const os = require('os');
import { config, database, getErrorMessage, normalizeError } from './utils.js';


class Splash {
    constructor() {
        this.splash = document.querySelector(".splash");
        this.splashMessage = document.querySelector(".splash-message");
        this.splashAuthor = document.querySelector(".splash-author");
        this.message = document.querySelector(".message");
        this.progress = document.querySelector(".progress");
        document.addEventListener('DOMContentLoaded', async () => {
            let databaseLauncher = new database();
            let configClient = await databaseLauncher.readData('configClient');
            let theme = configClient?.launcher_config?.theme || "auto"
            let isDarkTheme = await ipcRenderer.invoke('is-dark-theme', theme).then(res => res)
            document.body.className = isDarkTheme ? 'dark global' : 'light global';
            if (process.platform == 'win32') ipcRenderer.send('update-window-progress-load')
            this.startAnimation()
        });
    }

    async startAnimation() {
        let splashes = [
            { "message": "Je... vie...", "author": "Luuxis" },
            { "message": "Salut je suis du code.", "author": "Luuxis" },
            { "message": "Linux n'est pas un os, mais un kernel.", "author": "Luuxis" }
        ];
        let splash = splashes[Math.floor(Math.random() * splashes.length)];
        this.splashMessage.textContent = splash.message;
        this.splashAuthor.children[0].textContent = "@" + splash.author;
        await sleep(100);
        document.querySelector("#splash").style.display = "block";
        await sleep(500);
        this.splash.classList.add("opacity");
        await sleep(500);
        this.splash.classList.add("translate");
        this.splashMessage.classList.add("opacity");
        this.splashAuthor.classList.add("opacity");
        this.message.classList.add("opacity");
        await sleep(1000);
        this.checkUpdate();
    }

    async checkUpdate() {
        this.setStatus(`Recherche de mise à jour...`);

        let updateHandled = false;

        ipcRenderer.on('updateAvailable', () => {
            updateHandled = true;
            this.setStatus(`Mise à jour disponible !`);
            if (os.platform() == 'win32') {
                this.toggleProgress();
                ipcRenderer.send('start-update');
            }
            else return this.dowloadUpdate();
        })

        ipcRenderer.on('error', (event, err) => {
            if (err) return this.shutdown(getErrorMessage(err, 'Une erreur est survenue pendant la mise a jour.'));
        })

        ipcRenderer.on('download-progress', (event, progress) => {
            ipcRenderer.send('update-window-progress', { progress: progress.transferred, size: progress.total })
            this.setProgress(progress.transferred, progress.total);
        })

        ipcRenderer.on('update-not-available', () => {
            updateHandled = true;
            console.error("Mise à jour non disponible");
            this.maintenanceCheck();
        })

        try {
            await ipcRenderer.invoke('update-app');
        } catch (error) {
            if (!updateHandled) {
                return this.shutdown(`Erreur lors de la recherche de mise a jour :<br>${getErrorMessage(error, 'Operation impossible.')}`);
            }
        }
    }

    getLatestReleaseForOS(os, preferredFormat, asset) {
        return asset.filter(asset => {
            const name = asset.name.toLowerCase();
            const isOSMatch = name.includes(os);
            const isFormatMatch = name.endsWith(preferredFormat);
            return isOSMatch && isFormatMatch;
        }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    }

    async dowloadUpdate() {
        try {
            const repoURL = pkg.repository.url.replace("git+", "").replace(".git", "").replace("https://github.com/", "").split("/");
            const githubAPI = await config.request('https://api.github.com', {
                retries: 0,
                fallbackMessage: 'Impossible de contacter GitHub.'
            });

            const githubAPIRepoURL = githubAPI.repository_url.replace("{owner}", repoURL[0]).replace("{repo}", repoURL[1]);
            const githubAPIRepo = await config.request(githubAPIRepoURL, {
                retries: 0,
                fallbackMessage: 'Impossible de recuperer le depot GitHub.'
            });

            const releases = await config.request(githubAPIRepo.releases_url.replace("{/id}", ''), {
                retries: 0,
                fallbackMessage: 'Impossible de recuperer les releases GitHub.'
            });

            const latestRelease = releases?.[0]?.assets || [];
            let latest;

            if (os.platform() == 'darwin') latest = this.getLatestReleaseForOS('mac', '.dmg', latestRelease);
            else if (os.platform() == 'linux') latest = this.getLatestReleaseForOS('linux', '.appimage', latestRelease);

            if (!latest?.browser_download_url) {
                throw new Error('Aucun binaire de mise a jour compatible n a ete trouve.');
            }

            this.setStatus(`Mise à jour disponible !<br><div class="download-update">Télécharger</div>`);
            document.querySelector(".download-update").addEventListener("click", () => {
                shell.openExternal(latest.browser_download_url);
                return this.shutdown("Téléchargement en cours...");
            }, { once: true });
        } catch (error) {
            const normalizedError = normalizeError(error, {
                code: 'UPDATE_DOWNLOAD_ERROR',
                message: 'Impossible de preparer le telechargement de la mise a jour.'
            });
            console.error('Unable to prepare update download', normalizedError);
            return this.shutdown(getErrorMessage(normalizedError, 'Impossible de preparer la mise a jour.'));
        }
    }


    async maintenanceCheck() {
        try {
            const launcherConfig = await config.GetConfig();
            if (launcherConfig.maintenance) return this.shutdown(launcherConfig.maintenance_message);
            this.startLauncher();
        } catch (error) {
            console.error('Maintenance check failed', error);
            return this.shutdown(`${getErrorMessage(error, 'Aucune connexion internet detectee.')}<br>Veuillez reessayer ulterieurement.`);
        }
    }

    startLauncher() {
        this.setStatus(`Démarrage du launcher`);
        ipcRenderer.send('main-window-open');
        ipcRenderer.send('update-window-close');
    }

    shutdown(text) {
        this.setStatus(`${text}<br>Arrêt dans 5s`);
        let i = 4;
        const interval = setInterval(() => {
            this.setStatus(`${text}<br>Arrêt dans ${i--}s`);
            if (i < 0) {
                clearInterval(interval);
                ipcRenderer.send('update-window-close');
            }
        }, 1000);
    }

    setStatus(text) {
        this.message.innerHTML = text;
    }

    toggleProgress() {
        if (this.progress.classList.toggle("show")) this.setProgress(0, 1);
    }

    setProgress(value, max) {
        this.progress.value = value;
        this.progress.max = max;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.keyCode == 73 || e.keyCode == 123) {
        ipcRenderer.send("update-window-dev-tools");
    }
})
new Splash();