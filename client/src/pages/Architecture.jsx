import React from 'react';
import SeoPageLayout, { BulletList, Card, CardGrid, CardText, CardTitle, Section, SectionHeading, SectionText } from '../components/SeoPageLayout';

const Architecture = () => (
  <SeoPageLayout
    title="ARC AI Architecture | WebSockets, Tool Routing, and Streaming"
    description="Understand the ARC AI architecture: WebSocket communication, tool routing, execution pipeline, and streaming responses."
    eyebrow="System design"
    heroTitle="ARC AI uses a hybrid real-time architecture"
    heroLead="The system combines REST, WebSockets, tool execution, and streaming so messages can be routed quickly and results can be delivered in real time."
    stats={[
      { value: 'WebSocket channel', label: 'Keeps the assistant responsive while messages and events stream live.' },
      { value: 'Tool router', label: 'Decides whether to answer directly, call a tool, or schedule work.' },
      { value: 'Streaming output', label: 'Users see progress and partial responses as the system works.' },
    ]}
    ctaTitle="See the system as one pipeline"
    ctaText="ARC AI is easiest to understand as a request lifecycle: input, routing, decision, execution, and streaming back to the user."
  >
    <Section>
      <SectionHeading>Request lifecycle</SectionHeading>
      <CardGrid>
        <Card>
          <CardTitle>1. Input</CardTitle>
          <CardText>The user sends a message, voice command, or action request into the system.</CardText>
        </Card>
        <Card>
          <CardTitle>2. Routing</CardTitle>
          <CardText>The request is classified and routed toward the right assistant or processing path.</CardText>
        </Card>
        <Card>
          <CardTitle>3. Tool decision</CardTitle>
          <CardText>The model or controller decides whether it needs memory, search, automation, or a direct reply.</CardText>
        </Card>
        <Card>
          <CardTitle>4. Execution</CardTitle>
          <CardText>The selected tool runs, whether that means scraping, scheduling, recalling memory, or sending data.</CardText>
        </Card>
        <Card>
          <CardTitle>5. Streaming</CardTitle>
          <CardText>Results are returned over the live channel so the interface can stay responsive.</CardText>
        </Card>
      </CardGrid>
    </Section>

    <Section>
      <SectionHeading>Why the hybrid model works</SectionHeading>
      <SectionText>
        REST is good for request/response flows, while WebSockets are better for live conversation and streaming events.
        ARC AI uses both so the product can handle deterministic operations and interactive chat in one system.
      </SectionText>
      <BulletList>
        <li>WebSockets keep the UX responsive during long-running tasks.</li>
        <li>REST handles standard API-style operations cleanly.</li>
        <li>Tool routing keeps the assistant flexible without making the UI complex.</li>
      </BulletList>
    </Section>
  </SeoPageLayout>
);

export default Architecture;