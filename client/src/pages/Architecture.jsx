// client/src/pages/Architecture.jsx

import React from 'react';
import styled from 'styled-components';
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
} from '../components/SeoPageLayout';

/* ----------------------------------------------------------------------- */
/* Signature element: an animated request-lifecycle pipeline.               */
/* This is a real, ordered sequence — input always precedes routing,        */
/* which always precedes execution — so numbering carries information.     */
/* ----------------------------------------------------------------------- */

const PipelineWrap = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 0;
  margin-top: 28px;
  overflow-x: auto;
  padding-bottom: 8px;

  @media (max-width: 760px) {
    flex-direction: column;
    gap: 18px;
  }
`;

const Stage = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 150px;
  text-align: center;
  flex-shrink: 0;

  @media (max-width: 760px) {
    flex-direction: row;
    align-items: flex-start;
    text-align: left;
    min-width: 0;
    width: 100%;
    gap: 14px;
  }
`;

const NodeCircle = styled.div`
  width: 46px;
  height: 46px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: ui-monospace, SFMono-Regular, 'Fira Code', Menlo, Consolas, monospace;
  font-weight: 700;
  font-size: 14px;
  color: #04040f;
  background: linear-gradient(135deg, #00ffff, #8a2be2);
  box-shadow: 0 0 18px rgba(0, 255, 255, 0.35);
  flex-shrink: 0;
  position: relative;
  z-index: 2;
`;

const Connector = styled.div`
  flex: 1;
  height: 2px;
  margin-top: 23px;
  min-width: 24px;
  background: linear-gradient(90deg, rgba(0, 255, 255, 0.5), rgba(138, 43, 226, 0.5));
  position: relative;
  overflow: hidden;

  &::after {
    content: '';
    position: absolute;
    top: 0;
    left: -30%;
    width: 30%;
    height: 100%;
    background: linear-gradient(90deg, transparent, #ffffff, transparent);
    animation: travel 2.6s linear infinite;
  }

  @keyframes travel {
    0% { left: -30%; }
    100% { left: 100%; }
  }

  @media (max-width: 760px) {
    width: 2px;
    height: 28px;
    min-width: 0;
    margin: 0 0 0 22px;

    &::after {
      top: -30%;
      left: 0;
      width: 100%;
      height: 30%;
      background: linear-gradient(180deg, transparent, #ffffff, transparent);
      animation: travel-v 2.6s linear infinite;
    }
    @keyframes travel-v {
      0% { top: -30%; }
      100% { top: 100%; }
    }
  }
`;

const StageLabel = styled.div`
  margin-top: 12px;
  font-size: 13.5px;
  font-weight: 700;
  color: #fff;

  @media (max-width: 760px) {
    margin-top: 2px;
  }
`;

const StageText = styled.div`
  margin-top: 4px;
  font-size: 12.5px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.55);
  max-width: 160px;

  @media (max-width: 760px) {
    max-width: none;
  }
`;

const STAGES = [
  { label: 'Input', text: 'Message, voice command, or webcam frame enters the system.' },
  { label: 'Routing', text: 'The request is classified toward the right workspace and processing path.' },
  { label: 'Tool decision', text: 'The router picks memory, search, automation, vision, or a direct reply.' },
  { label: 'Execution', text: 'The selected tool runs — scraping, scheduling, recall, or messaging.' },
  { label: 'Streaming', text: 'Results return over the live socket channel as they become ready.' },
];

const Pipeline = () => (
  <PipelineWrap role="list" aria-label="ARC-AI request lifecycle">
    {STAGES.map((stage, index) => (
      <React.Fragment key={stage.label}>
        <Stage role="listitem">
          <NodeCircle>{index + 1}</NodeCircle>
          <div>
            <StageLabel>{stage.label}</StageLabel>
            <StageText>{stage.text}</StageText>
          </div>
        </Stage>
        {index < STAGES.length - 1 && <Connector aria-hidden="true" />}
      </React.Fragment>
    ))}
  </PipelineWrap>
);

/* ----------------------------------------------------------------------- */

const Architecture = () => (
  <SeoPageLayout
    title="ARC-AI Architecture | WebSockets, Tool Routing, and Streaming"
    description="Understand the ARC-AI architecture: WebSocket communication, provider-orchestrated routing, multi-workspace isolation, and streaming responses."
    eyebrow="System design"
    heroTitle="A hybrid real-time runtime, not a single prompt loop"
    heroLead="ARC-AI combines REST, WebSockets, provider-orchestrated tool routing, and streaming so every workspace stays isolated while responses still arrive in real time."
    stats={[
      { value: 'Socket.IO channel', label: 'Keeps the assistant responsive while messages and events stream live.' },
      { value: 'Workspace isolation', label: 'Scoped execution buckets and Pinecone namespaces per workspace.' },
      { value: 'Recovery above the provider', label: 'Failure handling sits outside the model layer to preserve streaming.' },
    ]}
    ctaTitle="See the runtime end to end"
    ctaText="The system is easiest to understand as one request lifecycle: input, routing, decision, execution, and streaming back to the user."
  >
    <Section>
      <SectionTag>Request lifecycle</SectionTag>
      <SectionHeading>Five stages, one socket connection</SectionHeading>
      <SectionText>
        Every interaction — typed, spoken, or visual — moves through the same five-stage pipeline before a token
        ever reaches the screen.
      </SectionText>
      <Pipeline />
    </Section>

    <Divider />

    <Section>
      <SectionTag>Provider orchestration</SectionTag>
      <SectionHeading>Routing intelligence, not a single model</SectionHeading>
      <SectionText>
        ARC-AI does not call one model for everything. A routing layer picks Gemini for reasoning, multimodal
        input, and planning, or Mistral when speed and cost matter more — for example, fast summarization or
        short tool replies.
      </SectionText>
      <CardGrid $min="220px">
        <Card>
          <CardTitle>Gemini</CardTitle>
          <CardText>Used for deeper reasoning, multimodal input from the live vision pipeline, and multi-step planning.</CardText>
        </Card>
        <Card>
          <CardTitle>Mistral</CardTitle>
          <CardText>Used for fast, cost-effective responses — summarization, short replies, and embedding generation for memory.</CardText>
        </Card>
        <Card>
          <CardTitle>Pixtral</CardTitle>
          <CardText>Handles vision specifically: webcam frames captured the moment a user speaks are routed here alongside speech-to-text.</CardText>
        </Card>
      </CardGrid>
    </Section>

    <Section>
      <SectionTag>Multi-workspace runtime</SectionTag>
      <SectionHeading>Isolation without losing real time</SectionHeading>
      <SectionText>
        Released in v0.13.0-beta, every workspace now behaves as its own intelligent runtime environment rather
        than a shared thread with a label on top.
      </SectionText>
      <BulletList>
        <li>Conversations are scoped per workspace and rebind safely on switch, so stale context never leaks across projects.</li>
        <li>Each workspace gets an isolated Pinecone vector namespace, keeping semantic memory from bleeding between contexts.</li>
        <li>Socket synchronization is workspace-safe, preventing duplicate listeners and cross-workspace execution contamination.</li>
        <li>Recovery logic lives above the provider layer instead of mutating continuation chains, which preserves streaming continuity and tool-call consistency even when a step fails.</li>
      </BulletList>
    </Section>

    <Section>
      <SectionTag>Why hybrid transport</SectionTag>
      <SectionHeading>REST for operations, WebSockets for conversation</SectionHeading>
      <SectionText>
        REST suits deterministic request/response work, while WebSockets carry the live conversation, voice input,
        and streaming tokens. ARC-AI uses both so the product can handle standard API operations and interactive
        chat inside one system instead of choosing one transport for everything.
      </SectionText>
    </Section>
  </SeoPageLayout>
);

export default Architecture;