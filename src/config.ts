export interface Env {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;

  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;

  ADMIN_ID?: string;
  ADMIN_UID?: string;
  ADMIN_BOOTSTRAP_UID?: string;
  ADMIN_API_KEY?: string;
  ADMIN_DASHBOARD_URL?: string;
  ALLOWED_ORIGINS?: string;
  PUBLIC_APP_ORIGIN?: string; // Kept for backward compatibility
  RATE_LIMIT_KV?: any;
  ENVIRONMENT?: string;
  SKIP_REVOCATION_CHECK?: boolean | string;
}

export const SUBSCRIPTION_PLANS = [
  {
    id: 'core99',
    name: 'Core Plan',
    priceINR: 99,
    annualPriceINR: 948,
    durationDays: 30,
    features: [
      'Up to 150 Students',
      'Up to 10 Batches',
      'Up to 5 Staff Members',
      'Attendance & Fee Tracking',
      'Cloud Sync & Multi-Device Access',
      'Basic PDF Receipts'
    ]
  },
  {
    id: 'smart199',
    name: 'Smart Plan',
    priceINR: 199,
    annualPriceINR: 1908,
    durationDays: 30,
    features: [
      'Unlimited Students, Batches & Staff',
      'Full Academics Hub (Homework & Tests)',
      'Study Materials & Lesson Plans',
      'Automated WhatsApp Reports & Queue',
      'Graphical Performance PDF Reports',
      'Student ID Cards & Merit Certificates'
    ]
  }
];

export const DEFAULT_TRIAL_DAYS = 7;

