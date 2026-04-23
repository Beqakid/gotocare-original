// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Invoices: CollectionConfig = {
  slug: 'invoices',
  admin: {
    useAsTitle: 'invoiceNumber',
  },
  fields: [
    {
      name: 'client',
      type: 'relationship',
      relationTo: 'clients',
      required: true,
    },
    {
      name: 'caregiver',
      type: 'relationship',
      relationTo: 'caregivers',
    },
    {
      name: 'invoiceNumber',
      type: 'text',
      required: true,
      unique: true,
    },
    {
      name: 'periodStart',
      type: 'date',
    },
    {
      name: 'periodEnd',
      type: 'date',
    },
    {
      name: 'totalHours',
      type: 'number',
    },
    {
      name: 'hourlyRate',
      type: 'number',
    },
    {
      name: 'amount',
      type: 'number',
      required: true,
    },
    {
      name: 'tax',
      type: 'number',
      defaultValue: 0,
    },
    {
      name: 'totalAmount',
      type: 'number',
      admin: {
        description: 'amount + tax',
      },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'draft',
      options: [
        { label: 'Draft', value: 'draft' },
        { label: 'Sent', value: 'sent' },
        { label: 'Paid', value: 'paid' },
        { label: 'Overdue', value: 'overdue' },
        { label: 'Cancelled', value: 'cancelled' },
      ],
    },
    {
      name: 'issuedDate',
      type: 'date',
    },
    {
      name: 'dueDate',
      type: 'date',
    },
    {
      name: 'paidDate',
      type: 'date',
    },
    {
      name: 'paymentMethod',
      type: 'select',
      options: [
        { label: 'Bank Transfer', value: 'bank_transfer' },
        { label: 'Check', value: 'check' },
        { label: 'Credit Card', value: 'credit_card' },
        { label: 'Cash', value: 'cash' },
        { label: 'Insurance', value: 'insurance' },
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
      return true
    },
    create: ({ req: { user } }) => !!user,
    update: ({ req: { user } }) => !!user,
    delete: ({ req: { user } }) => user?.role === 'admin',
  },
}
