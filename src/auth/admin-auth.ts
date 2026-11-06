import { Env } from '../config';
import { FirestoreClient } from '../firebase/firestore';
import { ForbiddenError } from '../utils/errors';

export async function verifyAdminUser(
  uid: string,
  env: Env,
  firestore: FirestoreClient
): Promise<boolean> {
  if (!uid) {
    throw new ForbiddenError('Unauthorized: Missing user UID');
  }

  // 1. Check designated Admin ID from environment secret
  const configuredAdminIds = [
    env.ADMIN_ID,
    env.ADMIN_UID,
    env.ADMIN_BOOTSTRAP_UID,
  ].filter(Boolean).map((id) => (id as string).trim());

  if (configuredAdminIds.includes(uid.trim())) {
    return true;
  }

  // 2. Query admin_users/{uid} in Firestore
  const adminDoc = await firestore.getDocument<{ active?: boolean; role?: string }>(
    `admin_users/${uid}`
  );

  if (adminDoc && adminDoc.active === true && adminDoc.role === 'admin') {
    return true;
  }

  throw new ForbiddenError('Administrator permissions required for this operation');
}

