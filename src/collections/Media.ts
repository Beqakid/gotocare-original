// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Media: CollectionConfig = {
  slug: 'media',
  access: {
    read: () => true,
    create: ({ req }) => !!req.user,
  },
  hooks: {
    beforeValidate: [
      ({ data }) => {
        if (data && !data.alt) {
          data.alt = data.filename || 'Uploaded media'
        }
        return data
      },
    ],
  },
  fields: [
    {
      name: 'alt',
      type: 'text',
      required: true,
    },
  ],
  upload: {
    crop: false,
    focalPoint: false,
    disableLocalStorage: true,
    skipSafeFetch: true,
  },
}
