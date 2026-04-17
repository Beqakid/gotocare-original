// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Clients: CollectionConfig = {
  slug: 'clients',
  admin: {
    useAsTitle: 'firstName',
  },
  fields: [
    {
      name: 'firstName',
      type: 'text',
      required: true,
    },
    {
      name: 'lastName',
      type: 'text',
      required: true,
    },
    {
      name: 'email',
      type: 'email',
    },
    {
      name: 'phone',
      type: 'text',
    },
    {
      name: 'addressStreet',
      type: 'text',
    },
    {
      name: 'addressCity',
      type: 'text',
    },
    {
      name: 'addressState',
      type: 'text',
    },
    {
      name: 'addressZip',
      type: 'text',
    },
    {
      name: 'dateOfBirth',
      type: 'date',
    },
    {
      name: 'emergencyContactName',
      type: 'text',
    },
    {
      name: 'emergencyContactPhone',
      type: 'text',
    },
    {
      name: 'emergencyContactRelationship',
      type: 'text',
    },
    {
      name: 'careNeeds',
      type: 'textarea',
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      options: [
        { label: 'Active', value: 'active' },
        { label: 'Inactive', value: 'inactive' },
        { label: 'Pending', value: 'pending' },
      ],
    },
    {
      name: 'notes',
      type: 'textarea',
    },
  ],
  access: {
    read: ({ req: { user } }) => {
      if (!user) return false
      if (user.role === 'admin') return true
      return true
    },
    create: ({ req: { user } }) => !!user,
    update: ({ req: { user } }) => !!user,
    delete: ({ req: { user } }) => user?.role === 'admin',
  },
}
