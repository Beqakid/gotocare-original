// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Clients: CollectionConfig = {
  slug: 'clients',
  admin: {
    useAsTitle: 'firstName',
  },
  fields: [
    {
      name: 'agency',
      type: 'relationship',
      relationTo: 'agencies',
      admin: { description: 'Agency this client belongs to' },
    },
    {
      name: 'location',
      type: 'relationship',
      relationTo: 'locations',
      admin: { description: 'Branch/location serving this client' },
    },
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
      name: 'requiredSkills',
      type: 'json',
      admin: { description: 'Required skills JSON array e.g. ["personal_care","companionship"]' },
    },
    {
      name: 'preferredLanguage',
      type: 'text',
      admin: { description: 'Preferred language for caregiver' },
    },
    {
      name: 'careHoursPerWeek',
      type: 'number',
      admin: { description: 'Hours of care needed per week' },
    },
    {
      name: 'preferredSchedule',
      type: 'textarea',
      admin: { description: 'Preferred days/times for care visits' },
    },
    {
      name: 'insuranceProvider',
      type: 'text',
    },
    {
      name: 'insurancePolicyNumber',
      type: 'text',
    },
    {
      name: 'leadSource',
      type: 'text',
      admin: { description: 'How this client was acquired (auto-set from lead)' },
    },
    {
      name: 'matchedCaregiver',
      type: 'relationship',
      relationTo: 'caregivers',
      admin: { description: 'Primary assigned caregiver (from matching or manual)' },
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
      if (user.agency) {
        const agencyId = typeof user.agency === 'object' ? user.agency.id : user.agency
        return { agency: { equals: agencyId } }
      }
      return true
    },
    create: ({ req: { user } }) => !!user,
    update: ({ req: { user } }) => {
      if (!user) return false
      if (user.role === 'admin') return true
      if (user.agency) {
        const agencyId = typeof user.agency === 'object' ? user.agency.id : user.agency
        return { agency: { equals: agencyId } }
      }
      return true
    },
    delete: ({ req: { user } }) => user?.role === 'admin' || user?.role === 'agency_owner',
  },
}
