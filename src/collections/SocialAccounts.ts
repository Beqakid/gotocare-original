// @ts-nocheck
import type { CollectionConfig } from 'payload';

export const SocialAccounts: CollectionConfig = {
  slug: 'social-accounts',
  access: {
    read: () => true,
    create: () => true,
    update: () => true,
    delete: () => true,
  },
  fields: [
    { name: 'agency_id', type: 'number', required: true },
    { name: 'platform', type: 'select', required: true, options: [
      { label: 'Facebook', value: 'facebook' },
      { label: 'Instagram', value: 'instagram' },
      { label: 'TikTok', value: 'tiktok' },
      { label: 'X / Twitter', value: 'twitter' },
      { label: 'LinkedIn', value: 'linkedin' },
      { label: 'Google Business', value: 'google_business' },
    ]},
    { name: 'account_name', type: 'text' },
    { name: 'account_id', type: 'text' },
    { name: 'access_token', type: 'text' },
    { name: 'refresh_token', type: 'text' },
    { name: 'token_expires_at', type: 'text' },
    { name: 'status', type: 'select', defaultValue: 'connected', options: [
      { label: 'Connected', value: 'connected' },
      { label: 'Disconnected', value: 'disconnected' },
      { label: 'Expired', value: 'expired' },
    ]},
  ],
};
