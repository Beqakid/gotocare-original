// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Services: CollectionConfig = {
  slug: 'services',
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'description',
      type: 'textarea',
    },
    {
      name: 'defaultRate',
      type: 'number',
    },
    {
      name: 'category',
      type: 'select',
      required: true,
      options: [
        { label: 'Home Care', value: 'home_care' },
        { label: 'Senior Care', value: 'senior_care' },
        { label: 'Private Duty', value: 'private_duty' },
        { label: 'Companionship', value: 'companionship' },
        { label: 'Medical', value: 'medical' },
      ],
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'active',
      options: [
        { label: 'Active', value: 'active' },
        { label: 'Inactive', value: 'inactive' },
      ],
    },
  ],
  access: {
    read: () => true,
    create: ({ req: { user } }) => !!user,
    update: ({ req: { user } }) => !!user,
    delete: ({ req: { user } }) => user?.role === 'admin',
  },
}
