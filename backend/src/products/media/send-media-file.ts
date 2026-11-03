import type { Request, Response } from 'express';

/** Express owns stream cleanup; an aborted transfer must not start another response. */
export function sendMediaFile(request: Request, response: Response, path: string): Promise<void> {
    if (request.aborted || response.destroyed || response.socket?.destroyed) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
        let closedPrematurely = false;
        const onClose = () => { closedPrematurely = !response.writableFinished; };
        response.once('close', onClose);

        const finish = (error?: Error) => {
            const transport = error as NodeJS.ErrnoException | undefined;
            const disconnectError = transport?.code === 'ECONNABORTED' || transport?.code === 'ECONNRESET' ||
                (transport?.code === 'EPIPE' && transport.syscall === 'write');
            const settle = () => {
                response.removeListener('close', onClose);
                // IncomingMessage.destroyed is deliberately excluded: a normal GET
                // request can be destroyed after its body finishes, while its response is still open.
                const disconnected = request.aborted || (!response.writableFinished &&
                    (closedPrematurely || response.destroyed || response.socket?.destroyed));
                if (!error || (disconnectError && disconnected)) resolve();
                else reject(error);
            };
            // A socket error can reach the sendFile callback just before 'close'.
            // Let that state settle before deciding whether it was a client disconnect.
            if (disconnectError) setImmediate(settle);
            else settle();
        };

        try {
            response.sendFile(path, { cacheControl: false, acceptRanges: true }, finish);
        } catch (error) {
            response.removeListener('close', onClose);
            reject(error);
        }
    });
}
