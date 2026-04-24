// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Caregivers: CollectionConfig = {
  slug: 'caregivers',
  admin: {
    useAsTitle: 'firstName',
  },
  fields: [
    {
      name: 'agency',
      type: 'relationship',
      relationTo: 'agencies',
      admin: { description: 'Agency this caregiver belongs to' },
    },
    {
      name: 'location',
      type: 'relationship',
      relationTo: 'locations',
      admin: { description: 'Branch/location this caregiver works from' },
    },
    {
      name: 'linkedUser',
      type: 'relationship',
      relationTo: 'users',
      admin: { description: 'User account for caregiver portal access' },
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
      required: true,
    },
    {
      name: 'phone',
      type: 'text',
    },
    {
      name: 'photoUrl',
      type: 'text',
      admin: { description: 'Profile photo URL' },
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
      name: 'emergencyContactName',
      type: 'text',
    },
    {
      name: 'emergencyContactPhone',
      type: 'text',
    },
    {
      name: 'emergencyContactRelation',
      type: 'text',
    },
    {
      name: 'skills',
      type: 'json',
      admin: { description: 'Skills JSON array e.g. ["personal_care","dementia_care","meal_prep"]' },
    },
    {
      name: 'certifications',
      type: 'textarea',
    },
    {
      name: 'hourlyRate',
      type: 'number',
    },
    {
      name: 'experienceYears',
      type: 'number',
      admin: { description: 'Years of caregiving experience' },
    },
    {
      name: 'languages',
      type: 'text',
      admin: { description: 'Languages spoken (comma-separated)' },
    },
    {
      name: 'availability',
      type: 'textarea',
      admin: { description: 'Available days/times (freeform)' },
    },
    {
      name: 'availabilityJson',
      type: 'json',
      admin: { description: 'Structured weekly availability: { mon: { start, end }, tue: ... }' },
    },
    {
      name: 'maxHoursPerWeek',
      type: 'number',
      admin: { description: 'Maximum hours caregiver wants to work per week' },
    },
    {
      name: 'onboardingStatus',
      type: 'select',
      defaultValue: 'pending',
      options: [
        { label: 'Invited', value: 'invited' },
        { label: 'In Progress', value: 'in_progress' },
        { label: 'Under Review', value: 'review' },
        { label: 'Active', value: 'active' },
        { label: 'Rejected', value: 'rejected' },
        { label: 'Pending', value: 'pending' },
      ],
      admin: { description: 'Onboarding progress status' },
    },
    {
      name: 'onboardingProgress',
      type: 'json',
      admin: { description: 'Track which onboarding steps are complete: { profile: true, documents: false, ... }' },
    },
    {
      name: 'complianceStatus',
      type: 'select',
      defaultValue: 'pending',
      options: [
        { label: 'Pending', value: 'pending' },
        { label: 'Compliant', value: 'compliant' },
        { label: 'Expired', value: 'expired' },
        { label: 'Non-Compliant', value: 'non_compliant' },
      ],
      admin: { description: 'Overall compliance status based on document checks' },
    },
    {
      name: 'inviteToken',
      type: 'text',
      admin: { description: 'Unique token for onboarding invite link' },
    },
    {
      name: 'invitedAt',
      type: 'date',
    },
    {
      name: 'onboardingCompletedAt',
      type: 'date',
    },
    {
      name: 'trainingAcknowledged',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: 'Has caregiver acknowledged agency training/policies' },
    },
    {
      name: 'hipaaAcknowledged',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: 'Has caregiver acknowledged HIPAA compliance' },
    },
    {
      name: 'eSignature',
      type: 'text',
      admin: { description: 'E-signature (typed name) for agreements' },
    },
    {
      name: 'eSignatureDate',
      type: 'date',
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
        { label: 'Onboarding', value: 'onboarding' },
      ],
    },
    {
      name: 'hireDate',
      type: 'date',
    },
    {
      name: 'specialties',
      type: 'text',
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
