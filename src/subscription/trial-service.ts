import { FirestoreClient } from '../firebase/firestore';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { addDays, nowIso, nowUtc } from '../utils/dates';
import { DEFAULT_TRIAL_DAYS } from '../config';

export class TrialService {
  private firestore: FirestoreClient;

  constructor(firestore: FirestoreClient) {
    this.firestore = firestore;
  }

  async startAutomaticTrial(instituteId: string, userUid: string) {
    const institute = await this.firestore.getDocument<{
      id?: string;
      name?: string;
      ownerUid?: string;
      trialUsed?: boolean;
      subscriptionStatus?: string;
      trialStartedAt?: string;
      trialEndsAt?: string;
      licenseKey?: string;
    }>(`institutes/${instituteId}`);

    if (!institute) {
      throw new NotFoundError(`Institute ${instituteId} not found`);
    }

    // Authorization: User must be institute owner or matching UID
    const ownerUid = institute.ownerUid || institute.id;
    if (ownerUid && ownerUid !== userUid && instituteId !== userUid) {
      throw new ForbiddenError('You are not authorized to activate a trial for this institute');
    }

    if (institute.subscriptionStatus === 'active') {
      throw new ConflictError('Institute already has an active paid subscription');
    }

    // Fast check: if institute record already marks trialUsed
    if (institute.trialUsed === true) {
      if (institute.trialEndsAt && new Date(institute.trialEndsAt).getTime() > Date.now()) {
        return {
          success: true,
          instituteId,
          trialEndsAt: institute.trialEndsAt,
          durationDays: DEFAULT_TRIAL_DAYS,
          licenseKey: institute.licenseKey || `LIC-TRIAL-${instituteId.substring(0, 8).toUpperCase()}`,
          status: 'trial',
          isExisting: true,
        };
      }
      throw new ConflictError('Trial has already been consumed for this institute');
    }

    // Check deterministic trial document
    const existingTrialDoc = await this.firestore.getDocument<{
      trialId?: string;
      startAt?: string;
      endAt?: string;
      licenseKey?: string;
    }>(`subscription_trials/${instituteId}`);

    if (existingTrialDoc) {
      if (existingTrialDoc.endAt && new Date(existingTrialDoc.endAt).getTime() > Date.now()) {
        return {
          success: true,
          instituteId,
          trialEndsAt: existingTrialDoc.endAt,
          durationDays: DEFAULT_TRIAL_DAYS,
          licenseKey: existingTrialDoc.licenseKey || institute.licenseKey || `LIC-TRIAL-${instituteId.substring(0, 8).toUpperCase()}`,
          status: 'trial',
          isExisting: true,
        };
      }
      throw new ConflictError('Trial has already been consumed for this institute');
    }

    const startAt = nowUtc();
    const endAt = addDays(startAt, DEFAULT_TRIAL_DAYS);
    const licenseKey = `LIC-TRIAL-${instituteId.substring(0, 8).toUpperCase()}-${Date.now().toString().slice(-4)}`;

    try {
      // Concurrency-safe atomic commit with existence precondition on subscription_trials/${instituteId}
      await this.firestore.commitBatchWrites([
        {
          currentDocument: { exists: false },
          update: {
            name: `subscription_trials/${instituteId}`,
            fields: {
              trialId: `trial_${instituteId}`,
              instituteId,
              durationDays: DEFAULT_TRIAL_DAYS,
              startAt: startAt.toISOString(),
              endAt: endAt.toISOString(),
              licenseKey,
              grantedBy: 'system_automatic',
              reason: 'Initial 7-day institute registration trial',
              createdAt: nowIso(),
            },
          },
        },
        {
          update: {
            name: `institutes/${instituteId}`,
            fields: {
              trialUsed: true,
              trialStartedAt: startAt.toISOString(),
              trialEndsAt: endAt.toISOString(),
              subscriptionStatus: 'trial',
              planTier: 'smart199',
              licenseKey,
              updatedAt: nowIso(),
            },
            updateMask: [
              'trialUsed',
              'trialStartedAt',
              'trialEndsAt',
              'subscriptionStatus',
              'planTier',
              'licenseKey',
              'updatedAt',
            ],
          },
        },
        {
          update: {
            name: `institutes/${instituteId}/license/current`,
            fields: {
              licenseKey,
              planId: 'smart199',
              status: 'active',
              isTrial: true,
              activatedAt: startAt.toISOString(),
              validUntil: endAt.toISOString(),
              updatedAt: nowIso(),
            },
            updateMask: [
              'licenseKey',
              'planId',
              'status',
              'isTrial',
              'activatedAt',
              'validUntil',
              'updatedAt',
            ],
          },
        },
        {
          update: {
            name: `subscription_audit_logs/log_${Date.now()}`,
            fields: {
              action: 'TRIAL_STARTED_AUTOMATIC',
              instituteId,
              performedBy: userUid,
              oldValue: institute.subscriptionStatus || 'none',
              newValue: 'trial',
              reason: '7-day automated trial activation',
              timestamp: nowIso(),
            },
          },
        },
      ]);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        errMsg.includes('already exists') ||
        errMsg.includes('ALREADY_EXISTS') ||
        errMsg.includes('FAILED_PRECONDITION')
      ) {
        // A concurrent request won the race. Re-fetch and return the valid trial state or reject
        const createdTrial = await this.firestore.getDocument<{
          trialId?: string;
          startAt?: string;
          endAt?: string;
          licenseKey?: string;
        }>(`subscription_trials/${instituteId}`);

        if (createdTrial?.endAt && new Date(createdTrial.endAt).getTime() > Date.now()) {
          return {
            success: true,
            instituteId,
            trialEndsAt: createdTrial.endAt,
            durationDays: DEFAULT_TRIAL_DAYS,
            licenseKey: createdTrial.licenseKey || licenseKey,
            status: 'trial',
            isExisting: true,
          };
        }
        throw new ConflictError('Trial has already been consumed for this institute');
      }
      throw err;
    }

    return {
      success: true,
      instituteId,
      trialEndsAt: endAt.toISOString(),
      durationDays: DEFAULT_TRIAL_DAYS,
      licenseKey,
      status: 'trial',
    };
  }

  async grantAdminTrial(
    instituteId: string,
    durationDays: number,
    reason: string,
    adminUid: string
  ) {
    if (durationDays <= 0 || durationDays > 365) {
      throw new AppError('Trial duration must be between 1 and 365 days', 400);
    }

    const institute = await this.firestore.getDocument<{
      name?: string;
      subscriptionStatus?: string;
      trialEndsAt?: string;
    }>(`institutes/${instituteId}`);

    if (!institute) {
      throw new NotFoundError(`Institute ${instituteId} not found`);
    }

    const startAt = nowUtc();
    const endAt = addDays(startAt, durationDays);
    const trialId = `admin_trial_${instituteId}_${Date.now()}`;
    const licenseKey = `LIC-ADMIN-${instituteId.substring(0, 8).toUpperCase()}-${Date.now().toString().slice(-4)}`;

    await this.firestore.commitBatchWrites([
      {
        update: {
          name: `subscription_trials/${trialId}`,
          fields: {
            trialId,
            instituteId,
            durationDays,
            startAt: startAt.toISOString(),
            endAt: endAt.toISOString(),
            grantedBy: adminUid,
            reason: reason || 'Admin trial grant',
            createdAt: nowIso(),
          },
        },
      },
      {
        update: {
          name: `institutes/${instituteId}`,
          fields: {
            trialStartedAt: startAt.toISOString(),
            trialEndsAt: endAt.toISOString(),
            subscriptionStatus: 'trial',
            planTier: 'smart199',
            licenseKey,
            updatedAt: nowIso(),
          },
          updateMask: [
            'trialStartedAt',
            'trialEndsAt',
            'subscriptionStatus',
            'planTier',
            'licenseKey',
            'updatedAt',
          ],
        },
      },
      {
        update: {
          name: `institutes/${instituteId}/license/current`,
          fields: {
            licenseKey,
            planId: 'smart199',
            status: 'active',
            isTrial: true,
            activatedAt: startAt.toISOString(),
            validUntil: endAt.toISOString(),
            updatedAt: nowIso(),
          },
          updateMask: [
            'licenseKey',
            'planId',
            'status',
            'isTrial',
            'activatedAt',
            'validUntil',
            'updatedAt',
          ],
        },
      },
      {
        update: {
          name: `subscription_audit_logs/log_${Date.now()}`,
          fields: {
            action: 'ADMIN_TRIAL_GRANTED',
            instituteId,
            performedBy: adminUid,
            oldValue: institute.subscriptionStatus || 'unknown',
            newValue: `trial_${durationDays}d`,
            reason: reason || 'Administrative trial grant',
            timestamp: nowIso(),
          },
        },
      },
    ]);

    return {
      success: true,
      instituteId,
      trialEndsAt: endAt.toISOString(),
      durationDays,
      licenseKey,
      status: 'trial',
    };
  }

  async revokeSubscription(instituteId: string, reason: string, adminUid: string) {
    const institute = await this.firestore.getDocument<{
      subscriptionStatus?: string;
    }>(`institutes/${instituteId}`);

    if (!institute) {
      throw new NotFoundError(`Institute ${instituteId} not found`);
    }

    await this.firestore.commitBatchWrites([
      {
        update: {
          name: `institutes/${instituteId}`,
          fields: {
            subscriptionStatus: 'revoked',
            updatedAt: nowIso(),
          },
          updateMask: ['subscriptionStatus', 'updatedAt'],
        },
      },
      {
        update: {
          name: `institutes/${instituteId}/license/current`,
          fields: {
            status: 'revoked',
            validUntil: nowIso(),
            updatedAt: nowIso(),
          },
          updateMask: ['status', 'validUntil', 'updatedAt'],
        },
      },
      {
        update: {
          name: `subscription_audit_logs/log_${Date.now()}`,
          fields: {
            action: 'ADMIN_SUBSCRIPTION_REVOKED',
            instituteId,
            performedBy: adminUid,
            oldValue: institute.subscriptionStatus || 'unknown',
            newValue: 'revoked',
            reason: reason || 'Administrative revocation',
            timestamp: nowIso(),
          },
        },
      },
    ]);

    return {
      success: true,
      instituteId,
      status: 'revoked',
      message: 'Subscription or trial successfully revoked',
    };
  }
}

