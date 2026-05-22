import React from 'react'
import './styles.css'

export const metadata = {
  description: 'Carehia is being redesigned while Kai is prepared for clients and caregivers.',
  title: 'Carehia',
}

export default async function RootLayout(props: { children: React.ReactNode }) {
  const { children } = props

  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
}
