'use client';

import { useState, useEffect } from 'react';
import type { StewIntProps } from './StewIntLoader';

const STEPS = [
  { id: 'overview', num: '★', label: 'Overview' },
  { id: 'entryA', num: 'A', label: 'Entry A: Outbound' },
  { id: 'entryB', num: 'B', label: 'Entry B: Organic' },
  { id: 'step0', num: '0', label: 'Find Leads' },
  { id: 'step1', num: '1', label: 'Research' },
  { id: 'step2', num: '2', label: 'Audit' },
  { id: 'step3', num: '3', label: 'Email' },
  { id: 'step4', num: '4', label: 'LinkedIn' },
  { id: 'step5', num: '5', label: 'Report Page' },
  { id: 'step6', num: '6', label: 'Engage' },
  { id: 'step7', num: '7', label: 'Convert' },
  { id: 'backlog', num: 'B', label: 'Backlog' },
];

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return isMobile;
}

const ACCENT = '#7BC9A0';
const ORANGE = '#C0613A';

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#1e1e1e', border: '1px solid #333', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', color: '#888', marginBottom: 4, letterSpacing: 1 }}>{label}</div>
      {children}
    </div>
  );
}

function WhyBox({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#1a2620', borderLeft: `3px solid ${ACCENT}`, padding: '12px 16px', borderRadius: '0 8px 8px 0', marginBottom: 12, fontSize: 13, lineHeight: 1.7, color: '#bbb' }}>
      {children}
    </div>
  );
}

function StatRow({ stats }: { stats: { value: string; label: string; note: string }[] }) {
  return (
    <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
      {stats.map((s, i) => (
        <div key={i} style={{ background: '#1e1e1e', border: '1px solid #333', borderRadius: 8, padding: '12px 16px', textAlign: 'center', flex: 1, minWidth: 80 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: ACCENT }}>{s.value}</div>
          <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase' }}>{s.label}</div>
          <div style={{ fontSize: 10, color: '#555' }}>{s.note}</div>
        </div>
      ))}
    </div>
  );
}

function FunnelArrow({ steps }: { steps: { label: string; sub: string; bg: string; color?: string }[] }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '20px 0' }}>
      {steps.map((s, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {i > 0 && <span style={{ color: '#555' }}>→</span>}
          <div style={{ background: s.bg, color: s.color || 'white', padding: '8px 12px', borderRadius: 6, fontSize: 12, textAlign: 'center', fontWeight: s.bg === ACCENT ? 700 : 400 }}>
            {s.label}<br /><span style={{ fontSize: 10, opacity: 0.7 }}>{s.sub}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function BacklogItem({ status, children }: { status: 'done' | 'todo' | 'blocked'; children: React.ReactNode }) {
  const colors = { done: { bg: '#2D5A3D', text: 'white' }, todo: { bg: ORANGE, text: 'white' }, blocked: { bg: '#666', text: 'white' } };
  const c = colors[status];
  return (
    <div style={{ background: '#1e1e1e', border: '1px solid #333', borderRadius: 6, padding: '10px 12px', marginBottom: 6, fontSize: 12, display: 'flex', gap: 8, alignItems: 'flex-start', color: '#bbb' }}>
      <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: c.bg, color: c.text, flexShrink: 0 }}>{status.toUpperCase()}</span>
      <span>{children}</span>
    </div>
  );
}

export default function FunnelInt({ stewardId, stewIntName, color }: StewIntProps) {
  const [activeStep, setActiveStep] = useState('overview');
  const accentColor = color || ACCENT;
  const isMobile = useIsMobile();

  return (
    <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', height: '100%', fontFamily: 'system-ui, sans-serif', background: '#111', color: '#ddd' }}>
      {/* Nav — side on desktop, horizontal scroll on mobile */}
      {isMobile ? (
        <div style={{ background: '#1a1a1a', borderBottom: '1px solid #333', flexShrink: 0, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: accentColor, flexShrink: 0 }}>
            Funnel
          </span>
          <select
            value={activeStep}
            onChange={(e) => setActiveStep(e.target.value)}
            style={{
              flex: 1,
              background: '#252525',
              color: '#ddd',
              border: `1px solid ${accentColor}`,
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 13,
              appearance: 'auto',
              WebkitAppearance: 'menulist',
              outline: 'none',
            }}
          >
            {STEPS.map(step => (
              <option key={step.id} value={step.id}>
                {step.num} — {step.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div style={{ width: 180, background: '#1a1a1a', borderRight: '1px solid #333', flexShrink: 0, overflowY: 'auto' }}>
          <div style={{ padding: '12px 16px', fontSize: 13, fontWeight: 700, color: accentColor, borderBottom: '1px solid #333' }}>
            Covered Bridge Funnel
          </div>
          {STEPS.map(step => (
            <div
              key={step.id}
              onClick={() => setActiveStep(step.id)}
              style={{
                padding: '10px 12px', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                borderLeft: activeStep === step.id ? `3px solid ${accentColor}` : '3px solid transparent',
                background: activeStep === step.id ? '#1e2e24' : 'transparent',
                color: activeStep === step.id ? accentColor : '#bbb',
              }}
            >
              <span style={{
                background: activeStep === step.id ? '#2D5A3D' : '#333',
                color: activeStep === step.id ? 'white' : '#888',
                width: 18, height: 18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, fontWeight: 700, flexShrink: 0,
              }}>{step.num}</span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{step.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? 16 : 24 }}>
        {activeStep === 'overview' && (
          <div>
            <h2 style={{ color: accentColor, fontSize: 18, marginBottom: 4 }}>Funnel Overview</h2>
            <p style={{ color: '#888', fontSize: 11, marginBottom: 20 }}>Source of truth. Click any step to drill in.</p>
            <FunnelArrow steps={[
              { label: 'Find', sub: 'CourtListener', bg: '#2D5A3D' },
              { label: 'Research', sub: 'Live? Contact?', bg: '#2D5A3D' },
              { label: 'Audit', sub: 'Full scan', bg: '#2D5A3D' },
              { label: 'Email', sub: 'Day 1', bg: ORANGE },
              { label: 'LinkedIn', sub: 'Day 3/5', bg: ORANGE },
              { label: 'Report', sub: 'They click', bg: '#333' },
              { label: 'Engage', sub: 'Free stuff', bg: '#333' },
              { label: 'Pay', sub: '$29-99/mo', bg: ACCENT, color: '#111' },
            ]} />
            <WhyBox><strong style={{ color: ACCENT }}>Ethos:</strong> Helpful, not annoying. One email. The free report IS the marketing. We never promise compliance. Generosity first, payment optional.</WhyBox>
            <h3 style={{ color: '#ccc', fontSize: 14, margin: '16px 0 8px' }}>Stats (real data only)</h3>
            <StatRow stats={[
              { value: '2,500', label: 'Backlog leads', note: 'CourtListener 2023-2026' },
              { value: '5', label: 'Fully validated', note: 'Audited + contact found' },
              { value: '0', label: 'Emails sent', note: 'TBD' },
              { value: '0', label: 'Customers', note: 'TBD' },
            ]} />
          </div>
        )}

        {activeStep === 'entryA' && (
          <div>
            <h2 style={{ color: accentColor, fontSize: 18, marginBottom: 4 }}>Entry Point A: Outbound</h2>
            <p style={{ color: '#888', fontSize: 11, marginBottom: 20 }}>CourtListener → Research → Audit → Email → LinkedIn → Report → Engage → Convert</p>
            <FunnelArrow steps={[
              { label: 'CourtListener', sub: 'Find defendants', bg: '#2D5A3D' },
              { label: 'Research', sub: 'Validate lead', bg: '#2D5A3D' },
              { label: 'Audit', sub: 'Full scan', bg: '#2D5A3D' },
              { label: 'Email', sub: 'Day 1', bg: ORANGE },
              { label: 'LinkedIn', sub: 'Day 3/5', bg: ORANGE },
              { label: 'Report', sub: 'They click', bg: '#333' },
              { label: 'Engage', sub: 'Free actions', bg: '#333' },
              { label: 'Convert', sub: '$29-99/mo', bg: ACCENT, color: '#111' },
            ]} />
            <WhyBox><strong style={{ color: ACCENT }}>Why outbound:</strong> We already know they were sued. We already audited their site. The email is about THEM specifically — not a cold pitch.</WhyBox>
          </div>
        )}

        {activeStep === 'entryB' && (
          <div>
            <h2 style={{ color: accentColor, fontSize: 18, marginBottom: 4 }}>Entry Point B: Organic</h2>
            <p style={{ color: '#888', fontSize: 11, marginBottom: 20 }}>Landing Page → Free Scan Form → Audit → Email → Report → Chat → Convert</p>
            <FunnelArrow steps={[
              { label: 'Landing Page', sub: 'SEO/ads', bg: '#4A90D9' },
              { label: 'Free Scan', sub: 'Enter URL', bg: '#4A90D9' },
              { label: 'Audit', sub: 'Auto-scan', bg: '#2D5A3D' },
              { label: 'Email', sub: 'Results ready', bg: ORANGE },
              { label: 'Report', sub: 'Full findings', bg: '#333' },
              { label: 'Chat', sub: 'Questions?', bg: '#333' },
              { label: 'Convert', sub: '$29-99/mo', bg: ACCENT, color: '#111' },
            ]} />
            <WhyBox><strong style={{ color: ACCENT }}>Why organic:</strong> They come to US. They enter their own URL. The scan is free. They get real findings. No lawsuit needed — any business that cares about accessibility can use this. Widens the TAM beyond lawsuit defendants.</WhyBox>
            <Card label="Landing page requirements">
              <ul style={{ paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: '#bbb' }}>
                <li>Simple headline: "Is your website accessible? Find out in 60 seconds."</li>
                <li>One input: their URL</li>
                <li>One button: "Free Scan"</li>
                <li>Social proof: number of scans run, maybe testimonials later</li>
                <li>SEO targeting: "ADA website compliance check", "WCAG audit tool"</li>
              </ul>
            </Card>
            <Card label="Flow after scan">
              <ul style={{ paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: '#bbb' }}>
                <li>Scan runs automatically (same audit pipeline as outbound)</li>
                <li>Email with results link sent immediately</li>
                <li>Report page shows findings — same experience as outbound leads</li>
                <li>Chat widget connects to Sales for questions</li>
                <li>Convert via same Stripe checkout</li>
              </ul>
            </Card>
          </div>
        )}

        {activeStep === 'step0' && (
          <div>
            <h2 style={{ color: accentColor, fontSize: 18, marginBottom: 4 }}>Step 0: Find Leads</h2>
            <p style={{ color: '#888', fontSize: 11, marginBottom: 20 }}>CourtListener API. Free. ~3,848 web accessibility cases from 2023-2026.</p>
            <WhyBox><strong style={{ color: ACCENT }}>WHY:</strong> Lawsuit count + filing dates appear on their report page. Repeat defendants see "This is your 2nd filing." Creates urgency.</WhyBox>
            <Card label="What we collect">
              <ul style={{ paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: '#bbb' }}>
                <li>Case number, filing date, court</li>
                <li>How many times sued (repeat defendant check)</li>
                <li>Plaintiff name + law firm</li>
                <li>Complaint PDF if available</li>
              </ul>
            </Card>
            <Card label="Growth path">
              <p style={{ fontSize: 13, color: '#bbb' }}>Backlog: ~2,500 leads. One signup justifies UniCourt ($50/mo) for state courts.</p>
            </Card>
          </div>
        )}

        {activeStep === 'step1' && (
          <div>
            <h2 style={{ color: accentColor, fontSize: 18, marginBottom: 4 }}>Step 1: Research</h2>
            <p style={{ color: '#888', fontSize: 11, marginBottom: 20 }}>Quick checks before full audit. Filter out dead leads.</p>
            <WhyBox><strong style={{ color: ACCENT }}>WHY:</strong> Every data point serves the customer experience later. Platform determines fix path. Contact method determines outreach channel.</WhyBox>
            <Card label="Checklist">
              <ul style={{ paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: '#bbb' }}>
                <li>Is the site still live?</li>
                <li>Is it still a real business?</li>
                <li>What platform? (Shopify, WordPress, Squarespace, custom)</li>
                <li>Already using an overlay?</li>
                <li>Find a contact person</li>
                <li>Find an email</li>
              </ul>
            </Card>
          </div>
        )}

        {activeStep === 'step2' && (
          <div>
            <h2 style={{ color: accentColor, fontSize: 18, marginBottom: 4 }}>Step 2: Audit</h2>
            <p style={{ color: '#888', fontSize: 11, marginBottom: 20 }}>Full detection formula. Per-page scanning and storage.</p>
            <WhyBox><strong style={{ color: ACCENT }}>WHY:</strong> Findings become report page content. Screenshots become the interactive replay. "You were sued for X, it's still here."</WhyBox>
            <Card label="The formula">
              <ul style={{ paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: '#bbb' }}>
                <li>Crawl (find all pages, deep-crawl subdomains)</li>
                <li>Existence check (binary yes/no on every element)</li>
                <li>Quality check (AI reviews names, labels, alt text)</li>
                <li>Interactive walk (Tab through, test keyboard nav)</li>
                <li>Screenshots + bounding boxes (for interactive replay)</li>
              </ul>
            </Card>
          </div>
        )}

        {activeStep === 'step3' && (
          <div>
            <h2 style={{ color: accentColor, fontSize: 18, marginBottom: 4 }}>Step 3: Email</h2>
            <p style={{ color: '#888', fontSize: 11, marginBottom: 20 }}>Day 1. Plain text. Their findings. One link. Under 100 words.</p>
            <WhyBox><strong style={{ color: ACCENT }}>WHY it works:</strong> Plain text = "person" filter. Short enough to read. Information gap (3 of 8 findings). About THEM specifically. Costs nothing. Shows real work.</WhyBox>
            <Card label="Current email (V4)">
              <pre style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 1.8, color: '#ccc', whiteSpace: 'pre-wrap' }}>
{`Subject: Re: your ADA case - how to prevent a repeat

Hey {first_name},

Nobody wants to deal with an ADA lawsuit twice. We work with
businesses that have been through it and help them stay off the
plaintiff firms' scanning lists.

We took a look at {domain}. There are a few things that would
flag you for another round:

- {finding_1}
- {finding_2}
- {finding_3}

Here's a report with what we found and how to fix each one:
{report_link}

Josh
Covered Bridge`}
              </pre>
            </Card>
          </div>
        )}

        {activeStep === 'step4' && (
          <div>
            <h2 style={{ color: accentColor, fontSize: 18, marginBottom: 4 }}>Step 4: LinkedIn</h2>
            <p style={{ color: '#888', fontSize: 11, marginBottom: 20 }}>Day 3: connect (no note). Day 5: message if accepted.</p>
            <WhyBox><strong style={{ color: ACCENT }}>WHY spaced:</strong> Same-day email + LinkedIn triggers "I'm being targeted." Spaced touches feel like natural encounters.</WhyBox>
            <Card label="Sequence">
              <ul style={{ paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: '#bbb' }}>
                <li><strong>Day 3:</strong> Connection request. NO note.</li>
                <li><strong>Day 5:</strong> If accepted, short message + report link.</li>
                <li><strong>Done.</strong> One sequence, then we're out.</li>
              </ul>
            </Card>
          </div>
        )}

        {activeStep === 'step5' && (
          <div>
            <h2 style={{ color: accentColor, fontSize: 18, marginBottom: 4 }}>Step 5: Report Page</h2>
            <p style={{ color: '#888', fontSize: 11, marginBottom: 20 }}>They click the link. This IS the product.</p>
            <WhyBox><strong style={{ color: ACCENT }}>WHY this is the product:</strong> The report proves we did real work. The interactive replay shows THEIR actual site with THEIR actual issues. No competitor offers this.</WhyBox>
            <Card label="Page layout">
              <ul style={{ paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: '#bbb' }}>
                <li>Hero: website screenshot + issues panel</li>
                <li>Hover issue = screenshot scrolls to element</li>
                <li>Charts: severity + category breakdown</li>
                <li>Free actions: GitHub/Jira tickets, copy link</li>
                <li>Pricing: $29/mo Monitor, $99/mo Monitor+Tickets</li>
                <li>Chat: always-open, connects to Sales</li>
              </ul>
            </Card>
          </div>
        )}

        {activeStep === 'step6' && (
          <div>
            <h2 style={{ color: accentColor, fontSize: 18, marginBottom: 4 }}>Step 6: Engage</h2>
            <p style={{ color: '#888', fontSize: 11, marginBottom: 20 }}>Free actions build trust before asking for money.</p>
            <WhyBox><strong style={{ color: ACCENT }}>WHY free first:</strong> They've been burned by a lawsuit, maybe by an overlay. They don't trust easily. Free tickets prove real value.</WhyBox>
            <Card label="Free actions">
              <ul style={{ paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: '#bbb' }}>
                <li>See full report with all findings</li>
                <li>Connect GitHub/Jira and send tickets</li>
                <li>Copy report link / forward to dev team</li>
                <li>Chat with Sales</li>
              </ul>
            </Card>
          </div>
        )}

        {activeStep === 'step7' && (
          <div>
            <h2 style={{ color: accentColor, fontSize: 18, marginBottom: 4 }}>Step 7: Convert</h2>
            <p style={{ color: '#888', fontSize: 11, marginBottom: 20 }}>Stripe Checkout. Magic link auth. Account activates.</p>
            <WhyBox><strong style={{ color: ACCENT }}>WHY they pay:</strong> "This scan was free. Subscribe to catch new issues as your site changes." Value is proven. Payment is for ONGOING protection.</WhyBox>
            <Card label="Tiers">
              <ul style={{ paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: '#bbb' }}>
                <li><strong>$29/mo Monitor:</strong> Daily/weekly rescans. Alerts on new issues.</li>
                <li><strong>$99/mo Monitor + Tickets:</strong> + automatic GitHub/Jira tickets.</li>
                <li><strong>"Talk to us":</strong> Custom remediation. Routes to Sales.</li>
              </ul>
            </Card>
            <Card label="Tax credit angle">
              <p style={{ fontSize: 13, color: '#bbb' }}>Section 44 Disabled Access Tax Credit covers ~48%. $29/mo → ~$15/mo effective.</p>
            </Card>
          </div>
        )}

        {activeStep === 'backlog' && (
          <div>
            <h2 style={{ color: accentColor, fontSize: 18, marginBottom: 4 }}>Backlog</h2>
            <p style={{ color: '#888', fontSize: 11, marginBottom: 20 }}>Only things that directly serve the funnel.</p>
            <h3 style={{ color: '#ccc', fontSize: 14, margin: '16px 0 8px' }}>Blocking First Send</h3>
            <BacklogItem status="done">Buy outreach domain (coveredbridge.live)</BacklogItem>
            <BacklogItem status="done">Update LinkedIn headline</BacklogItem>
            <BacklogItem status="todo">Physical address for email footer</BacklogItem>
            <BacklogItem status="todo">Set up email on coveredbridge.live (DNS + Resend)</BacklogItem>
            <BacklogItem status="todo">Polish report page</BacklogItem>
            <BacklogItem status="todo">Deploy report page to coveredbridge.mullet.town</BacklogItem>
            <h3 style={{ color: '#ccc', fontSize: 14, margin: '16px 0 8px' }}>After First Send</h3>
            <BacklogItem status="todo">A/B tracking infrastructure</BacklogItem>
            <BacklogItem status="todo">Magic link auth for returning users</BacklogItem>
            <BacklogItem status="todo">GitHub OAuth integration</BacklogItem>
            <BacklogItem status="todo">Sales chat pipeline</BacklogItem>
            <h3 style={{ color: '#ccc', fontSize: 14, margin: '16px 0 8px' }}>Scale</h3>
            <BacklogItem status="todo">UniCourt integration ($50/mo for state courts)</BacklogItem>
            <BacklogItem status="todo">Automated pipeline (CourtListener → audit → email)</BacklogItem>
            <BacklogItem status="todo">Ongoing monitoring scheduler</BacklogItem>
          </div>
        )}
      </div>
    </div>
  );
}
