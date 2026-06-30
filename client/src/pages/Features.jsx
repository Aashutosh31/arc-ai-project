// client/src/pages/Features.jsx

import React from 'react';
import { Link } from 'react-router-dom';
import styled from 'styled-components';
import SeoPageLayout, {
  Card,
  CardGrid,
  CardText,
  CardTitle,
  Section,
  SectionHeading,
  SectionTag,
  SectionText,
  TechChip,
  TechRow,
} from '../components/SeoPageLayout';

const FeatureLink = styled(Link)`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 14px;
  color: #7df7ff;
  text-decoration: none;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.01em;

  &::after {
    content: '→';
    transition: transform 0.2s ease;
  }
  &:hover::after { transform: translateX(3px); }
  &:hover { color: #00ffff; }
`;

const FEATURES = [
  {
    title: 'Memory (RAG)',
    text: 'Long-term facts are embedded with Mistral and indexed in Pinecone, isolated per workspace, so the assistant recalls preferences and context with semantic search instead of forgetting after every reply.',
    to: '/features/rag-memory',
    label: 'Learn about memory',
  },
  {
    title: 'Live web research',
    text: 'Cheerio-based scraping and direct API calls pull current weather, news, and page content into the answer, so responses stay grounded in what is happening right now rather than stale training data.',
    to: '/features/web-research',
    label: 'See live research',
  },
  {
    title: 'Proactive automation',
    text: 'Natural language requests are converted into node-cron schedules and background jobs, so reminders and recurring routines run on their own without keeping a chat window open.',
    to: '/features/automation',
    label: 'Explore automation',
  },
  {
    title: 'Multi-workspace runtime',
    text: 'Every workspace runs as an isolated execution environment with its own conversations, Pinecone namespace, and socket channel — released in v0.13.0-beta to keep context from leaking between projects.',
    to: '/architecture',
    label: 'Read the architecture',
  },
  {
    title: 'Live vision & multimodal',
    text: 'A real-time webcam frame is captured the moment a user speaks and routed to the Pixtral vision model alongside speech-to-text, with guardrails to prevent silent attachment loss mid-stream.',
    to: '/architecture',
    label: 'How routing works',
  },
  {
    title: 'UI actuation & WhatsApp',
    text: 'ARC-AI can change themes, open sites, play media, copy to clipboard, and send WhatsApp messages on a user’s behalf — plus deliver email through a serverless Google Apps Script webhook.',
    to: '/about',
    label: 'More about ARC-AI',
  },
];

const Features = () => (
  <SeoPageLayout
    title="ARC-AI Features | Memory, Research, Automation, and Tooling"
    description="Explore ARC-AI features including RAG memory, live web research, automation, multi-workspace runtime, live vision, and UI actuation."
    eyebrow="v0.13.0-beta · Multi-workspace runtime"
    heroTitle="Six systems, one real-time assistant"
    heroLead="ARC-AI combines long-term memory, live research, automation, multimodal perception, and action-taking tools behind a single Socket.IO pipeline. Each capability is built to be genuinely useful, not just a demo."
    stats={[
      { value: 'RAG + Pinecone', label: 'Personalized context that persists across conversations and workspaces.' },
      { value: 'Gemini + Mistral', label: 'Intelligent provider routing picks reasoning power or speed per task.' },
      { value: 'Socket.IO pipeline', label: 'Hybrid REST + WebSocket runtime keeps every interaction responsive.' },
    ]}
    ctaTitle="See ARC-AI in action"
    ctaText="Open the live demo to chat with the assistant, or read the architecture page to see how requests are routed under the hood."
  >
    <Section>
      <SectionTag>Core capabilities</SectionTag>
      <SectionHeading>Built for real work, not just chat</SectionHeading>
      <SectionText>
        The product is organized around a small set of high-value capabilities that make the assistant feel fast,
        informed, and proactive instead of generic. Every card below maps to a system that actually ships in the
        codebase today.
      </SectionText>

      <CardGrid>
        {FEATURES.map((feature) => (
          <Card key={feature.title}>
            <CardTitle>{feature.title}</CardTitle>
            <CardText>{feature.text}</CardText>
            <FeatureLink to={feature.to}>{feature.label}</FeatureLink>
          </Card>
        ))}
      </CardGrid>
    </Section>

    <Section>
      <SectionTag>Under the hood</SectionTag>
      <SectionHeading>One stack, end to end</SectionHeading>
      <SectionText>
        Every feature above is powered by the same MERN-based runtime, so memory, research, and automation share
        one execution and streaming layer instead of bolted-on integrations.
      </SectionText>
      <TechRow>
        <TechChip>React 18</TechChip>
        <TechChip>Vite</TechChip>
        <TechChip>Tailwind CSS</TechChip>
        <TechChip>Node.js</TechChip>
        <TechChip>Express</TechChip>
        <TechChip>Socket.IO</TechChip>
        <TechChip>node-cron</TechChip>
        <TechChip>MongoDB Atlas</TechChip>
        <TechChip>Pinecone</TechChip>
        <TechChip>Gemini</TechChip>
        <TechChip>Mistral AI</TechChip>
        <TechChip>Pixtral</TechChip>
      </TechRow>
    </Section>
  </SeoPageLayout>
);

export default Features;