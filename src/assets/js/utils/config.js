/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const pkg = require('../package.json');
const convert = require('xml-js');
import { LauncherError, normalizeError, createHttpError } from './error.js';
let url = process.env.API_URL || pkg.url;

let config = `${url}/config`;
let articles = `${url}/articles`;

class Config {
    async request(resource, options = {}) {
        const {
            timeout = 10000,
            retries = 1,
            parse = 'json',
            fallbackMessage = 'Le serveur est inaccessible.'
        } = options;

        let lastError = null;

        for (let attempt = 0; attempt <= retries; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            try {
                const response = await fetch(resource, { signal: controller.signal, cache: 'no-store' });
                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw createHttpError(response, fallbackMessage);
                }

                if (parse === 'text') return await response.text();
                return await response.json();
            } catch (error) {
                clearTimeout(timeoutId);

                const isAbort = error?.name === 'AbortError';
                lastError = error instanceof LauncherError
                    ? error
                    : new LauncherError({
                        code: isAbort ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
                        message: isAbort ? 'Le serveur a mis trop de temps a repondre.' : fallbackMessage,
                        details: error?.message || null,
                        retryable: true,
                        cause: error
                    });

                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
                    continue;
                }
            }
        }

        throw normalizeError(lastError, {
            code: 'NETWORK_ERROR',
            message: fallbackMessage,
            retryable: true
        });
    }

    async GetConfig() {
        return await this.request(config, {
            retries: 1,
            fallbackMessage: 'Impossible de recuperer la configuration du launcher.'
        });
    }

    async getInstanceList() {
        const urlInstance = `${url}/instances`;
        const instances = await this.request(urlInstance, {
            retries: 1,
            fallbackMessage: 'Impossible de recuperer la liste des instances.'
        });

        if (!instances || typeof instances !== 'object' || Array.isArray(instances)) {
            throw new LauncherError({
                code: 'INVALID_INSTANCES_RESPONSE',
                message: 'La reponse du serveur pour les instances est invalide.'
            });
        }

        return [...Object.values(instances)];
    }

    async getNews(config) {
        if (config.rss) {
            const response = await this.request(config.rss, {
                parse: 'text',
                fallbackMessage: 'Impossible de recuperer le flux des actualites.'
            });
            const items = (JSON.parse(convert.xml2json(response, { compact: true })))?.rss?.channel?.item;
            const list = Array.isArray(items) ? items : items ? [items] : [];

            return list.map(item => ({
                title: item?.title?._text || 'Actualite',
                content: item?.['content:encoded']?._text || item?.description?._text || '',
                author: item?.['dc:creator']?._text || 'Equipe',
                publish_date: item?.pubDate?._text || new Date().toISOString()
            }));
        }

        const news = await this.request(articles, {
            retries: 1,
            fallbackMessage: 'Impossible de recuperer les actualites.'
        });

        if (!Array.isArray(news)) {
            throw new LauncherError({
                code: 'INVALID_NEWS_RESPONSE',
                message: 'La reponse du serveur pour les actualites est invalide.'
            });
        }

        return news;
    }
}

export default new Config;