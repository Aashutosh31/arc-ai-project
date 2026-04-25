import React from 'react';
import SeoPageLayout, { BulletList, Card, CardGrid, CardText, CardTitle, Section, SectionHeading, SectionText } from '../components/SeoPageLayout';

const Automation = () => (
  <SeoPageLayout
    title="Automation & Cron Jobs in ARC AI | Proactive Task Execution"
    description="ARC AI turns natural language into automation, cron jobs, reminders, and background execution so tasks can run proactively."
    eyebrow="Automation"
    heroTitle="ARC AI automation turns requests into scheduled work"
    heroLead="Instead of only responding in chat, ARC AI can convert natural language into tasks that run now or later. That makes the assistant proactive, not passive."
    stats={[
      { value: 'Natural language', label: 'Users describe the task in plain English and the system interprets the intent.' },
      { value: 'Cron scheduling', label: 'Scheduled jobs can run in the background at the right time.' },
      { value: 'Proactive behavior', label: 'ARC AI can remind, trigger, and execute without waiting for another prompt.' },
    ]}
    ctaTitle="Let ARC AI do the repetitive work"
    ctaText="Automation is where the assistant becomes a workflow engine. Move from asking for help to getting things done automatically."
  >
    <Section>
      <SectionHeading>How users automate tasks</SectionHeading>
      <SectionText>
        A user can describe a repeatable action, a reminder, or a timed workflow. ARC AI maps that request into a
        background execution pattern such as a reminder, scheduled job, or tool action.
      </SectionText>
      <BulletList>
        <li>Send reminders at a specific time or interval.</li>
        <li>Trigger background actions without keeping the chat open.</li>
        <li>Use the assistant for recurring operational work.</li>
      </BulletList>
    </Section>

    <Section>
      <SectionHeading>Why proactive AI is powerful</SectionHeading>
      <CardGrid>
        <Card>
          <CardTitle>Less manual repetition</CardTitle>
          <CardText>The assistant handles work that would normally require repeated user input.</CardText>
        </Card>
        <Card>
          <CardTitle>Faster follow-through</CardTitle>
          <CardText>Tasks can be planned once and executed later without extra coordination.</CardText>
        </Card>
        <Card>
          <CardTitle>Better workflow fit</CardTitle>
          <CardText>ARC AI becomes a lightweight operations layer instead of a pure chat interface.</CardText>
        </Card>
      </CardGrid>
    </Section>

    <Section>
      <SectionHeading>Simple execution model</SectionHeading>
      <SectionText>
        The assistant can translate intent into a cron-like schedule, store the task, and execute it in the background
        when the trigger condition is met.
      </SectionText>
    </Section>
  </SeoPageLayout>
);

export default Automation;