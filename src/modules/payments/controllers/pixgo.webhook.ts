import crypto from 'crypto';
import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

import { dispatchMerchantWebhook } from '../../../core/utils/webhook-dispatcher';
import {
  checkPixD1PaymentStatus,
  getPixD1Credentials
} from '../services/pixgo.service';

const prisma = new PrismaClient();

const asRecord = (value: unknown): Record<string, any> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  return {};
};

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const verifySignature = (
  rawBody: Buffer,
  timestamp: string,
  signature: string,
  secret: string
) => {
  if (!timestamp || !signature || !secret || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) return false;
  if (Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(signature, 'hex');

  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
};

const mergeRawResponse = (
  current: unknown,
  settlement: Record<string, any>
) => ({
  ...asRecord(current),
  settlement
});

export const handlePixD1Webhook = async (
  req: Request,
  res: Response
) => {
  try {
    const rawBodyValue = (req as any).rawBody;
    const rawBody = Buffer.isBuffer(rawBodyValue)
      ? rawBodyValue
      : Buffer.from(
          typeof rawBodyValue === 'string'
            ? rawBodyValue
            : JSON.stringify(req.body ?? {})
        );

    let payload: Record<string, any>;
    try {
      payload = asRecord(JSON.parse(rawBody.toString('utf8')));
    } catch {
      return res.status(400).json({ received: false, error: 'invalid_payload' });
    }

    const data = asRecord(payload.data ?? payload);
    const event = String(
      payload.event ?? req.get('x-webhook-event') ?? ''
    ).trim();
    const paymentId = String(
      data.payment_id ?? payload.payment_id ?? ''
    ).trim();
    const externalId = String(
      data.external_id ?? payload.external_id ?? ''
    ).trim();

    if (!event || (!paymentId && !externalId)) {
      return res.status(400).json({ received: false, error: 'invalid_payload' });
    }

    const orConditions: any[] = [];
    if (paymentId) orConditions.push({ providerId: paymentId });
    if (isUuid(externalId)) orConditions.push({ id: externalId });

    const transaction = await prisma.transaction.findFirst({
      where: {
        method: 'pix',
        OR: orConditions
      },
      include: { gatewayVault: true }
    });

    if (!transaction || !transaction.gatewayVault) {
      console.warn('[PIX-D1 WEBHOOK] Transaction not found', {
        paymentId: paymentId || null
      });
      return res.status(200).json({ received: true, ignored: true });
    }

    const providerAlias = String(transaction.gatewayVault.provider).toLowerCase();
    if (!providerAlias.startsWith('pix-d1')) {
      return res.status(200).json({ received: true, ignored: true });
    }

    const credentials = getPixD1Credentials(transaction.gatewayVault.credentials);
    if (!credentials.webhookSecret) {
      console.error('[PIX-D1 WEBHOOK] Webhook secret not configured', {
        transactionId: transaction.id
      });
      return res.status(500).json({ received: false, error: 'webhook_not_configured' });
    }

    const timestamp = String(req.get('x-webhook-timestamp') ?? '').trim();
    const signature = String(req.get('x-webhook-signature') ?? '').trim();

    if (!verifySignature(rawBody, timestamp, signature, credentials.webhookSecret)) {
      console.warn('[PIX-D1 WEBHOOK] Signature rejected', {
        transactionId: transaction.id,
        hasTimestamp: Boolean(timestamp),
        hasSignature: Boolean(signature)
      });
      return res.status(401).json({ received: false, error: 'invalid_signature' });
    }

    if (
      paymentId &&
      transaction.providerId &&
      transaction.providerId !== paymentId
    ) {
      return res.status(200).json({ received: true, ignored: true });
    }

    if (event === 'order.created') {
      return res.status(200).json({ received: true, ignored: true });
    }

    if (event === 'payment.completed') {
      if (transaction.status === 'succeeded') {
        return res.status(200).json({
          received: true,
          duplicate: true,
          transactionId: transaction.id,
          status: 'succeeded'
        });
      }

      if (!paymentId) {
        return res.status(500).json({ received: false, error: 'payment_id_missing' });
      }

      const verification = await checkPixD1PaymentStatus(
        transaction.gatewayVault.credentials,
        paymentId
      );
      const checked = asRecord(verification?.data);
      const providerStatus = String(checked.status ?? '').trim().toLowerCase();
      const checkedExternalId = String(checked.external_id ?? '').trim();
      const expectedAmount = Number(transaction.amount);
      const checkedAmount = Number(checked.amount);

      if (
        providerStatus !== 'completed' ||
        checkedExternalId !== transaction.id ||
        !Number.isFinite(checkedAmount) ||
        Math.abs(checkedAmount - expectedAmount) > 0.01
      ) {
        console.error('[PIX-D1 WEBHOOK] S2S verification failed', {
          transactionId: transaction.id,
          providerStatus,
          externalIdMatches: checkedExternalId === transaction.id,
          amountMatches:
            Number.isFinite(checkedAmount) &&
            Math.abs(checkedAmount - expectedAmount) <= 0.01
        });
        return res.status(500).json({ received: false, error: 'verification_failed' });
      }

      const amounts = asRecord(data.amounts);
      const gross = Number(amounts.gross ?? data.amount ?? expectedAmount);
      const providerFee = Number(amounts.fee_total);
      const netAmount = Number(amounts.net);
      const feePix = Number(amounts.fee_pixgo ?? 0);
      const feeSettlement = Number(amounts.fee_liquid ?? 0);

      if (
        !Number.isFinite(gross) ||
        Math.abs(gross - expectedAmount) > 0.01 ||
        !Number.isFinite(providerFee) ||
        providerFee < 0 ||
        !Number.isFinite(netAmount) ||
        netAmount < 0 ||
        netAmount > gross ||
        Math.abs(gross - providerFee - netAmount) > 0.02
      ) {
        console.error('[PIX-D1 WEBHOOK] Invalid financial breakdown', {
          transactionId: transaction.id,
          expectedAmount,
          gross,
          providerFee,
          netAmount
        });
        return res.status(500).json({ received: false, error: 'financial_breakdown_invalid' });
      }

      const settlement = {
        status: 'expected',
        mode: 'D1',
        asset: 'DEPIX',
        network: 'LIQUID',
        grossAmount: Number(gross.toFixed(2)),
        providerFee: Number(providerFee.toFixed(2)),
        feePix: Number((Number.isFinite(feePix) ? feePix : 0).toFixed(2)),
        feeSettlement: Number(
          (Number.isFinite(feeSettlement) ? feeSettlement : 0).toFixed(2)
        ),
        merchantNet: Number(netAmount.toFixed(2)),
        paymentConfirmedAt:
          data.completed_at ?? payload.timestamp ?? new Date().toISOString(),
        verifiedAt: new Date().toISOString()
      };

      const financialProcessingDone = await prisma.$transaction(async tx => {
        const claim = await tx.transaction.updateMany({
          where: {
            id: transaction.id,
            status: { notIn: ['succeeded', 'refunded'] }
          },
          data: {
            status: 'succeeded',
            fee: settlement.providerFee,
            rawResponse: mergeRawResponse(transaction.rawResponse, settlement)
          }
        });

        if (claim.count === 0) return false;

        const wallet = await tx.wallet.upsert({
          where: {
            merchantId_currency: {
              merchantId: transaction.merchantId,
              currency: 'BRL'
            }
          },
          update: {
            balance: { increment: settlement.merchantNet }
          },
          create: {
            merchantId: transaction.merchantId,
            currency: 'BRL',
            balance: settlement.merchantNet,
            available: 0,
            reserved: 0,
            type: 'fiat'
          }
        });

        await tx.walletMovement.create({
          data: {
            walletId: wallet.id,
            merchantId: transaction.merchantId,
            currency: 'BRL',
            type: 'payment',
            direction: 'in',
            amount: settlement.merchantNet,
            status: 'em_transito',
            reference: transaction.id,
            metadata: {
              method: 'pix',
              settlementMode: 'D1',
              settlementAsset: 'DEPIX',
              grossAmount: settlement.grossAmount,
              providerFee: settlement.providerFee,
              merchantNet: settlement.merchantNet
            }
          }
        });

        return true;
      });

      if (financialProcessingDone) {
        await dispatchMerchantWebhook(
          transaction.id,
          'payment_intent.succeeded',
          { method: 'pix', status: 'succeeded' }
        ).catch(error =>
          console.error('[PIX MERCHANT WEBHOOK ERROR]', error)
        );
      }

      console.log('[PIX WEBHOOK PROCESSED]', {
        transactionId: transaction.id,
        status: 'succeeded',
        amount: expectedAmount,
        netAmount: settlement.merchantNet,
        financialProcessingDone,
        rail: 'd1'
      });

      return res.status(200).json({
        received: true,
        transactionId: transaction.id,
        status: 'succeeded',
        financialProcessingDone
      });
    }

    if (event === 'payment.expired') {
      const result = await prisma.transaction.updateMany({
        where: {
          id: transaction.id,
          status: { notIn: ['succeeded', 'refunded'] }
        },
        data: {
          status: 'canceled',
          rawResponse: mergeRawResponse(transaction.rawResponse, {
            ...asRecord(asRecord(transaction.rawResponse).settlement),
            status: 'expired',
            expiredAt: data.expired_at ?? new Date().toISOString()
          })
        }
      });

      if (result.count > 0) {
        await dispatchMerchantWebhook(
          transaction.id,
          'payment_intent.canceled',
          { method: 'pix', status: 'canceled' }
        ).catch(() => undefined);
      }

      return res.status(200).json({ received: true, status: 'canceled' });
    }

    if (event === 'payment.refunded') {
      const previousSettlement = asRecord(asRecord(transaction.rawResponse).settlement);
      const previousNet = Number(previousSettlement.merchantNet ?? 0);
      const wasSucceeded = transaction.status === 'succeeded';

      const reversed = await prisma.$transaction(async tx => {
        const claim = await tx.transaction.updateMany({
          where: { id: transaction.id, status: { not: 'refunded' } },
          data: {
            status: 'refunded',
            rawResponse: mergeRawResponse(transaction.rawResponse, {
              ...previousSettlement,
              status: 'reversed',
              refundedAt: data.refunded_at ?? new Date().toISOString()
            })
          }
        });

        if (claim.count === 0) return false;

        if (wasSucceeded && Number.isFinite(previousNet) && previousNet > 0) {
          const existingReversal = await tx.walletMovement.findFirst({
            where: {
              merchantId: transaction.merchantId,
              reference: transaction.id,
              type: 'payment_refund'
            }
          });

          if (!existingReversal) {
            const wallet = await tx.wallet.findUnique({
              where: {
                merchantId_currency: {
                  merchantId: transaction.merchantId,
                  currency: 'BRL'
                }
              }
            });

            if (wallet) {
              await tx.wallet.update({
                where: { id: wallet.id },
                data: { balance: { decrement: previousNet } }
              });

              await tx.walletMovement.create({
                data: {
                  walletId: wallet.id,
                  merchantId: transaction.merchantId,
                  currency: 'BRL',
                  type: 'payment_refund',
                  direction: 'out',
                  amount: previousNet,
                  status: 'concluido',
                  reference: transaction.id,
                  metadata: {
                    method: 'pix',
                    reason: 'provider_refund'
                  }
                }
              });
            }
          }
        }

        return true;
      });

      if (reversed) {
        await dispatchMerchantWebhook(
          transaction.id,
          'charge.refunded',
          { method: 'pix', status: 'refunded' }
        ).catch(() => undefined);
      }

      return res.status(200).json({ received: true, status: 'refunded' });
    }

    return res.status(200).json({ received: true, ignored: true });
  } catch (error) {
    console.error('[PIX-D1 WEBHOOK ERROR]', error);
    return res.status(500).json({ received: false, error: 'processing_failed' });
  }
};
