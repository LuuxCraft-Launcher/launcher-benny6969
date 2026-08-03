/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

class LauncherError extends Error {
    constructor({ code = 'UNKNOWN_ERROR', message = 'Une erreur est survenue.', details = null, status = null, retryable = false, cause = null } = {}) {
        super(message);
        this.name = 'LauncherError';
        this.code = code;
        this.details = details;
        this.status = status;
        this.retryable = retryable;
        this.cause = cause;
    }
}

function normalizeError(error, fallback = {}) {
    if (error instanceof LauncherError) return error;

    if (error?.error instanceof LauncherError) return error.error;

    if (error?.error && typeof error.error === 'object') {
        return new LauncherError({
            code: error.error.code || fallback.code || 'UNKNOWN_ERROR',
            message: error.error.message || fallback.message || 'Une erreur est survenue.',
            details: error.error.details || error.details || null,
            status: error.error.status || null,
            retryable: Boolean(error.error.retryable),
            cause: error
        });
    }

    if (error instanceof Error) {
        return new LauncherError({
            code: fallback.code || error.name || 'UNEXPECTED_ERROR',
            message: error.message || fallback.message || 'Une erreur est survenue.',
            details: fallback.details || null,
            retryable: Boolean(fallback.retryable),
            cause: error
        });
    }

    if (typeof error === 'string') {
        return new LauncherError({
            code: fallback.code || 'UNEXPECTED_ERROR',
            message: error,
            details: fallback.details || null,
            retryable: Boolean(fallback.retryable)
        });
    }

    return new LauncherError({
        code: fallback.code || 'UNKNOWN_ERROR',
        message: fallback.message || 'Une erreur est survenue.',
        details: fallback.details || null,
        retryable: Boolean(fallback.retryable),
        cause: error || null
    });
}

function createHttpError(response, fallbackMessage = 'Le serveur est inaccessible.') {
    const status = response?.status || null;
    const statusText = response?.statusText || 'HTTP_ERROR';

    const apiMessages = {
        400: 'La requête envoyée au serveur est invalide.',
        401: 'Authentification requise.',
        403: 'Accès refusé par le serveur.',
        404: 'Ressource introuvable.',
        429: 'Trop de requêtes envoyées. Réessayez dans quelques instants.',
        500: 'Le serveur a rencontré une erreur interne.'
    };

    return new LauncherError({
        code: `HTTP_${status || statusText}`,
        message: apiMessages[status] || fallbackMessage,
        details: statusText,
        status,
        retryable: status === 429 || (status >= 500 && status < 600)
    });
}

function getErrorMessage(error, fallbackMessage = 'Une erreur est survenue.') {
    return normalizeError(error, { message: fallbackMessage }).message;
}

function getErrorCode(error, fallbackCode = 'ERROR') {
    return normalizeError(error, { code: fallbackCode }).code;
}

export {
    LauncherError,
    normalizeError,
    createHttpError,
    getErrorMessage,
    getErrorCode
};