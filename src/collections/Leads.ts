// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Leads: CollectionConfig = {
  slug: 'leads',
  admin: {
    useAsTitle: 'firstName',
  },
  fields: [
    {
      name: 'agency',
      type: 'relationship',
      relationTo: 'agencies',
      admin: { description: 'Agency this lead belongs to' },
    },
    {
      name: 'location',
      type: 'relationship',
      relationTo: 'locations',
      admin: { description: 'Specific agency location/branch for this lead' },
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
      name: 'careType',
      type: 'select',
      options: [
        { label: 'Home Care', value: 'home_care' },
        { label: 'Senior Care', value: 'senior_care' },
        { label: 'Private Duty', value: 'private_duty' },
        { label: 'Companionship', value: 'companionship' },
        { label: 'Respite Care', value: 'respite_care' },
      ],
    },
    {
      name: 'requiredSkills',
      type: 'select',
      hasMany: true,
      options: [
        { label: 'Personal Care', value: 'personal_care' },
        { label: 'Medication Management', value: 'medication_mgmt' },
        { label: 'Dementia Care', value: 'dementia_care' },
        { label: 'Alzheimer Care', value: 'alzheimer_care' },
        { label: 'Wound Care', value: 'wound_care' },
        { label: 'Mobility Assistance', value: 'mobility_assist' },
        { label: 'Meal Preparation', value: 'meal_prep' },
        { label: 'Light Housekeeping', value: 'housekeeping' },
        { label: 'Companionship', value: 'companionship' },
        { label: 'Transportation', value: 'transportation' },
        { label: 'Physical Therapy Aid', value: 'pt_aid' },
        { label: 'Hospice Care', value: 'hospice_care' },
        { label: 'Pediatric Care', value: 'pediatric_care' },
        { label: 'Post-Surgery Care', value: 'post_surgery' },
        { label: 'Vital Signs Monitoring', value: 'vitals_monitoring' },
      ],
      admin: { description: 'Skills needed for this care request' },
    },
    {
      name: 'preferredLanguage',
      type: 'text',
      admin: { description: 'Preferred language for caregiver' },
    },
    {
      name: 'careHoursPerWeek',
      type: 'number',
      admin: { description: 'Estimated hours of care needed per week' },
    },
    {
      name: 'urgency',
      type: 'select',
      defaultValue: 'routine',
      options: [
        { label: 'Routine', value: 'routine' },
        { label: 'Urgent', value: 'urgent' },
        { label: 'Emergency', value: 'emergency' },
      ],
    },
    {
      name: 'preferredSchedule',
      type: 'textarea',
      admin: { description: 'Preferred days/times for care visits' },
    },
    {
      name: 'message',
      type: 'textarea',
    },
    {
      name: 'source',
      type: 'select',
      defaultValue: 'website',
      options: [
        { label: 'Website', value: 'website' },
        { label: 'Referral', value: 'referral' },
        { label: 'Phone', value: 'phone' },
        { label: 'Landing Page', value: 'landing_page' },
        { label: 'Demo Request', value: 'demo_request' },
        { label: 'Other', value: 'other' },
      ],
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'new',
      options: [
        { label: 'New', value: 'new' },
        { label: 'Contacted', value: 'contacted' },
        { label: 'Qualified', value: 'qualified' },
        { label: 'Converted', value: 'converted' },
        { label: 'Lost', value: 'lost' },
      ],
    },
    {
      name: 'assignedTo',
      type: 'text',
      admin: { description: 'Staff member handling this lead' },
    },
    {
      name: 'followUpDate',
      type: 'date',
      admin: { description: 'Next follow-up date' },
    },
    {
      name: 'convertedClientId',
      type: 'number',
      admin: { description: 'Client ID if converted (auto-set)' },
    },
    {
      name: 'company',
      type: 'text',
      admin: { description: 'Agency/company name for demo requests' },
    },
    {
      name: 'matchedCaregivers',
      type: 'json',
      admin: { description: 'Auto-matched caregiver IDs and scores from matching algorithm' },
    },
    {
      name: 'notes',
      type: 'textarea',
    },
  ],
  access: {
    create: () => true,
    read: ({ req: { user } }) => {
      if (!user) return false
      if (user.role === 'admin') return true
      if (user.agency) {
        const agencyId = typeof user.agency === 'object' ? user.agency.id : user.agency
        return { agency: { equals: agencyId } }
      }
      return true
    },
    update: ({ req: { user } }) => !!user,
    delete: ({ req: { user } }) => user?.role === 'admin' || user?.role === 'agency_owner',
  },
}
