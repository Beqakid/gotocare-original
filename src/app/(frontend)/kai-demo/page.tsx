import Script from 'next/script'
import Link from 'next/link'
import React from 'react'

export const metadata = {
  title: 'Carehia Kai Demo',
  description: 'Partner demo for Kai as a Carehia onboarding assistant.',
}

const demoCards = [
  {
    title: 'Agency setup',
    body: 'Kai helps a care business describe services, coverage, contact details, and the first action a family should take.',
  },
  {
    title: 'Care workflows',
    body: 'The demo frames how Kai can later guide client intake, caregiver onboarding, schedules, notes, documents, and timesheets.',
  },
  {
    title: 'Safe assistance',
    body: 'Kai gives setup guidance and drafts. It does not approve caregivers, make care decisions, or replace professional judgement.',
  },
]

export default function KaiDemoPage() {
  return (
    <div className="carehia-kai-demo">
      <header className="carehia-demo-nav">
        <Link href="/" className="carehia-demo-brand" aria-label="Carehia home">
          <span>C</span>
          <strong>Carehia</strong>
        </Link>
        <span className="carehia-demo-pill">Partner demo</span>
      </header>

      <section className="carehia-demo-hero">
        <div className="carehia-demo-copy">
          <p className="carehia-demo-eyebrow">Kai AI Coach for Carehia</p>
          <h1>Show how Kai can onboard care teams through conversation.</h1>
          <p className="carehia-demo-lede">
            This demo keeps the main Carehia landing page untouched. Open Kai from the bottom-right
            button and use the sample flow to preview care agency onboarding.
          </p>
          <div className="carehia-demo-actions">
            <a href="#demo-flow">What to show</a>
            <Link href="/admin">Open Payload admin</Link>
          </div>
        </div>

        <div className="carehia-demo-panel" aria-label="Carehia Kai demo preview">
          <div className="carehia-demo-panel-head">
            <span>K</span>
            <div>
              <strong>Kai</strong>
              <p>Care onboarding assistant</p>
            </div>
          </div>
          <ol>
            <li>Ask what kind of care setup the partner wants to prepare.</li>
            <li>Collect agency name, services, service area, and contact details.</li>
            <li>Create a structured care setup preview for manual review.</li>
          </ol>
        </div>
      </section>

      <section id="demo-flow" className="carehia-demo-grid" aria-label="Kai demo capabilities">
        {demoCards.map((card) => (
          <article key={card.title}>
            <h2>{card.title}</h2>
            <p>{card.body}</p>
          </article>
        ))}
      </section>

      <footer className="carehia-demo-footer">
        Demo only. Production Carehia integration would save approved Kai outputs into the Carehia workspace.
      </footer>

      <Script
        src="https://kai.jjioji.workers.dev/embed/kai.js"
        data-app="carehia"
        data-user-role="partner_demo"
        strategy="afterInteractive"
      />
    </div>
  )
}
