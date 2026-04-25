import React from 'react';
import SeoPageLayout, { BulletList, Section, SectionHeading, SectionText } from '../components/SeoPageLayout';

const About = () => (
  <SeoPageLayout
    title="About ARC AI | Real-Time AI Assistant with Memory and Automation"
    description="Learn what ARC AI is, why it exists, and how it combines memory, web research, automation, and real-time execution."
    eyebrow="About ARC AI"
    heroTitle="A practical AI assistant built to take action"
    heroLead="ARC AI is designed as a real-time assistant for memory, research, automation, and tool-driven work. It is meant to feel more like a useful product than a generic chat window."
    stats={[
      { value: 'Product-first', label: 'Built to be understandable to users, teams, and search engines.' },
      { value: 'Tool-driven', label: 'Combines model reasoning with live actions and system integrations.' },
      { value: 'Future-ready', label: 'Structured so the assistant can grow into more tasks over time.' },
    ]}
    ctaTitle="Go back to the product overview"
    ctaText="Browse the features page to see how ARC AI is organized into searchable, user-facing product content."
  >
    <Section>
      <SectionHeading>What ARC AI is built for</SectionHeading>
      <SectionText>
        The goal is to combine conversational AI with practical execution. Instead of stopping at answers, ARC AI can
        remember, research, automate, and act.
      </SectionText>
      <BulletList>
        <li>Useful in real workflows, not just demos.</li>
        <li>Structured around transparent capabilities and routes.</li>
        <li>Designed to be easy to document and index.</li>
      </BulletList>
    </Section>
  </SeoPageLayout>
);

export default About;