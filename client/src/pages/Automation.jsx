// client/src/pages/Automation.jsx

import React from 'react';
import SeoPageLayout, {
  BulletList,
  Card,
  CardGrid,
  CardText,
  CardTitle,
  Divider,
  Section,
  SectionHeading,
  SectionTag,
  SectionText,
  TechChip,
  TechRow,
} from '../components/SeoPageLayout';

const DEMO_URL = 'https://www.instagram.com/aashutosh_vaishnav.31/reel/DW7DQ8lE-Wr/';

const Automation = () => (
  <SeoPageLayout
    title="Automation & Cron Jobs in ARC-AI | Proactive Task Execution"
    description="ARC-AI's Proactive Routine Engine turns natural language into node-cron jobs, WhatsApp automation, and background execution."
    eyebrow="Automation"
    heroTitle="The Proactive Routine Engine turns requests into scheduled work"
    heroLead="Instead of only responding in chat, ARC-AI converts natural language into tasks that run now or later — backed by node-cron and a background execution layer. That makes the assistant proactive, not passive."
    stats={[
      { value: 'Natural language', label: 'Describe the task in plain English; the system interprets the intent.' },
      { value: 'node-cron scheduling', label: 'Scheduled jobs run in the background at the right time, reliably.' },
      { value: 'WhatsApp delivery', label: 'Reminders and messages can be sent autonomously on the user’s behalf.' },
    ]}
    ctaTitle="Let ARC-AI do the repetitive work"
    ctaText="Automation is where the assistant becomes a workflow engine. Try the live demo and ask it to remind you of something."
  >
    <Section>
      <SectionTag>How it works</SectionTag>
      <SectionHeading>From a sentence to a scheduled job</SectionHeading>
      <SectionText>
        A user describes a repeatable action, a reminder, or a timed workflow in plain language. The Proactive
        Routine Engine maps that request into a node-cron schedule, stores it, and executes it in the background
        when the trigger condition is met — no chat window required to stay open.
      </SectionText>
      <BulletList>
        <li>Send reminders at a specific time or on a recurring interval.</li>
        <li>Trigger background actions without keeping the conversation active.</li>
        <li>Use the assistant for recurring operational work, not just one-off questions.</li>
      </BulletList>
    </Section>

    <Divider />

    <Section>
      <SectionTag>Why proactive matters</SectionTag>
      <SectionHeading>From answering to following through</SectionHeading>
      <CardGrid>
        <Card>
          <CardTitle>Less manual repetition</CardTitle>
          <CardText>The assistant handles work that would normally require the user to type the same request again and again.</CardText>
        </Card>
        <Card>
          <CardTitle>Faster follow-through</CardTitle>
          <CardText>Tasks are planned once and executed later, without extra coordination or a reminder to remind yourself.</CardText>
        </Card>
        <Card>
          <CardTitle>WhatsApp automation</CardTitle>
          <CardText>Autonomous message creation and delivery integrate directly into the same agent workflow that handles scheduling.</CardText>
        </Card>
      </CardGrid>
    </Section>

    <Section>
      <SectionTag>Execution model</SectionTag>
      <SectionHeading>Cron underneath, conversation on top</SectionHeading>
      <SectionText>
        The assistant translates intent into a cron-like schedule, persists the task in MongoDB, and runs it in
        the background when the trigger condition fires — the same robust execution system that keeps reminders
        and recurring routines reliable.{' '}
        <a
          href={DEMO_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#7df7ff', fontWeight: 700, textDecoration: 'none' }}
        >
          Watch the routine engine demo →
        </a>
      </SectionText>
      <TechRow>
        <TechChip>node-cron</TechChip>
        <TechChip>Express.js</TechChip>
        <TechChip>MongoDB Atlas</TechChip>
        <TechChip>WhatsApp integration</TechChip>
      </TechRow>
    </Section>
  </SeoPageLayout>
);

export default Automation;