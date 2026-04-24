// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Invoices: CollectionConfig = {
  slug: 'invoices',
  admin: {
    useAsTitle: 'invoiceNumber',
  },
  fields: [
    {
      name: 'agency',
      type: 'relationship',
      relationTo: 'agencies',
      admin: { description: 'Agency this invoice belongs to' },
    },
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
      admin: { description: 'Primary caregiver for this invoice period' },
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
      admin: { description: 'Billing period start date' },
    },
    {
      name: 'periodEnd',
      type: 'date',
      admin: { description: 'Billing period end date' },
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
      admin: { description: 'Amount + tax' },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'draft',
      options: [
        { label: 'Draft', value: 'draft' },
        { label: 'Sent', value: 'sent' },
        { label: 'Pending', value: 'pending' },
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
        { label: 'Credit Card', value: 'credit_card' },
        { label: 'Bank Transfer', value: 'bank_transfer' },
        { label: 'Check', value: 'check' },
        { label: 'Cash', value: 'cash' },
        { label: 'Insurance', value: 'insurance' },
        { label: 'Stripe', value: 'stripe' },
      ],
    },
    {
      name: 'stripeSessionId',
      type: 'text',
      admin: { description: 'Stripe Checkout session ID' },
    },
    {
      name: 'stripePaymentId',
      type: 'text',
      admin: { description: 'Stripe Payment Intent ID' },
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
      if (user.agency) {
        const agencyId = typeof user.agency === 'object' ? user.agency.id : user.agency
        return { agency: { equals: agencyId } }
      }
      return true
    },
    create: ({ req: { user } }) => !!user,
    update: ({ req: { user } }) => !!user,
    delete: ({ req: { user } }) => user?.role === 'admin' || user?.role === 'agency_owner',
  },
}
