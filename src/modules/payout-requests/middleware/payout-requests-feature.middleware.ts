import {
  NextFunction,
  Request,
  Response
} from 'express';

const enabledValues =
  new Set([
    '1',
    'true',
    'yes',
    'on'
  ]);

export const payoutRequestsEnabled =
  (): boolean =>
    enabledValues.has(
      String(
        process.env
          .PAYOUT_REQUESTS_ENABLED ||
        'false'
      )
        .trim()
        .toLowerCase()
    );

export const payoutRequestsFeatureMiddleware =
  (
    _req: Request,
    res: Response,
    next: NextFunction
  ) => {
    if (!payoutRequestsEnabled()) {
      return res.status(404).json({
        success: false,

        error: {
          code:
            'PAYOUT_REQUESTS_DISABLED',

          message:
            'Funcionalidade indisponível.'
        }
      });
    }

    next();
  };
