/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const Store = require('electron-store');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { ipcRenderer } = require('electron');

let dev = process.env.NODE_ENV === 'dev';

class database {
    constructor() {
        this.store = null;
        this.initialized = false;
    }

    async initStore() {
        if (!this.initialized) {
            const userDataPath = await ipcRenderer.invoke('path-user-data');
            this.store = new Store({
                name: 'launcher-data',
                cwd: userDataPath,
                encryptionKey: dev ? undefined : (await this.getKey(32, userDataPath)),
            });
            this.initialized = true;
        }
        return this.store;
    }

    async createData(tableName, data) {
        await this.initStore();
        let tableData = this.store.get(tableName, []);

        // Générer un nouvel ID
        const maxId = tableData.length > 0
            ? Math.max(...tableData.map(item => item.ID || 0))
            : 0;
        const newId = maxId + 1;

        data.ID = newId;
        tableData.push(data);
        this.store.set(tableName, tableData);
        return data;
    }

    async readData(tableName, key = 1) {
        await this.initStore();
        let tableData = this.store.get(tableName, []);
        let data = tableData.find(item => item.ID === key);
        return data ? data : undefined;
    }

    async readAllData(tableName) {
        await this.initStore();
        return this.store.get(tableName, []);
    }

    async updateData(tableName, data, key = 1) {
        await this.initStore();
        let tableData = this.store.get(tableName, []);
        const index = tableData.findIndex(item => item.ID === key);

        if (index !== -1) {
            data.ID = key;
            tableData[index] = data;
            this.store.set(tableName, tableData);
        } else {
            data.ID = key;
            tableData.push(data);
            this.store.set(tableName, tableData);
        }
    }

    async deleteData(tableName, key = 1) {
        await this.initStore();
        let tableData = this.store.get(tableName, []);
        tableData = tableData.filter(item => item.ID !== key);
        this.store.set(tableName, tableData);
    }

    async ensureData(tableName, defaultData, key = 1, maxRetries = 5) {
        await this.initStore();

        let retries = 0;
        while (retries < maxRetries) {
            try {
                let existingData = await this.readData(tableName, key);
                if (existingData) return existingData;
                defaultData.ID = key;
                await this.createData(tableName, defaultData);
                return defaultData;
            } catch (error) {
                retries++;

                await new Promise(resolve => setTimeout(resolve, 100 * retries));
            }
        }
    }

    async initDefaultData() {
        await this.ensureData('configClient', {
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
        });
    }

    async getKey(length, userDataPath) {
        const keyPath = path.join(userDataPath, 'key.txt');

        if (fs.existsSync(keyPath)) {
            return fs.readFileSync(keyPath, 'utf-8');
        } else {
            const key = crypto.randomBytes(length).toString('hex');
            fs.writeFileSync(keyPath, key);
            return key;
        }
    }
}

export default database;