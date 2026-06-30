// client/src/pages/About.jsx

import React from 'react';
import styled from 'styled-components';
import SeoPageLayout, {
  BulletList,
  Divider,
  GithubIcon,
  LINKS,
  LinkedinIcon,
  Section,
  SectionHeading,
  SectionTag,
  SectionText,
  TechChip,
  TechRow,
  XIcon,
  YoutubeIcon,
} from '../components/SeoPageLayout';

/* ----------------------------------------------------------------------- */
/* Release timeline — a real chronological sequence, so version tags and   */
/* ordering carry information rather than decorate it.                     */
/* ----------------------------------------------------------------------- */

const Timeline = styled.div`
  position: relative;
  margin-top: 26px;
  padding-left: 26px;
  border-left: 2px solid rgba(0, 255, 255, 0.18);
  display: flex;
  flex-direction: column;
  gap: 30px;
`;

const TimelineItem = styled.div`
  position: relative;

  &::before {
    content: '';
    position: absolute;
    left: -33px;
    top: 4px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: linear-gradient(135deg, #00ffff, #8a2be2);
    box-shadow: 0 0 10px rgba(0, 255, 255, 0.6);
  }
`;

const TimelineVersion = styled.div`
  display: inline-block;
  font-family: ui-monospace, SFMono-Regular, 'Fira Code', Menlo, Consolas, monospace;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: #04040f;
  background: linear-gradient(135deg, #00ffff, #8a2be2);
  padding: 3px 9px;
  border-radius: 6px;
  margin-bottom: 8px;
`;

const TimelineTitle = styled.h3`
  font-size: 16px;
  font-weight: 700;
  color: #fff;
  margin: 0 0 6px;
`;

const TimelineText = styled.p`
  font-size: 14px;
  line-height: 1.65;
  color: rgba(255, 255, 255, 0.6);
  margin: 0;
  max-width: 600px;
`;

const RELEASES = [
  {
    version: 'v0.13.0-beta',
    title: 'Isolated multi-workspace execution',
    text: 'Every workspace became its own intelligent runtime: scoped conversations, workspace-aware execution buckets, and workspace-safe socket synchronization, plus a native modal-based workspace management UI replacing browser prompts.',
  },
  {
    version: 'v0.12.0-beta',
    title: 'Runtime architecture evolution',
    text: 'Introduced WorkspaceRuntimeManager.js to dynamically inject context, moved recovery logic above the provider layer to preserve streaming continuity, and gave every workspace its own isolated Pinecone vector namespace.',
  },
  {
    version: 'v0.11.0-beta',
    title: 'Intelligent workspace & provider routing',
    text: 'Established the intelligence layer: dynamic Gemini/Mistral routing, semantic workspace search, a four-layer memory lifecycle, and an intelligent retrieval layer with relevance scoring and recency weighting.',
  },
];

/* ----------------------------------------------------------------------- */
/* Author card                                                              */
/* ----------------------------------------------------------------------- */

const AuthorCard = styled.div`
  margin-top: 24px;
  padding: 26px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(0, 255, 255, 0.16);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
`;

const AuthorInfo = styled.div`
  h3 {
    font-size: 18px;
    margin: 0 0 4px;
    color: #fff;
  }
  p {
    font-size: 13.5px;
    color: rgba(255, 255, 255, 0.55);
    margin: 0;
    max-width: 440px;
    line-height: 1.6;
  }
`;

const AuthorLinks = styled.div`
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
`;

const IconButton = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 9px 13px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: rgba(255, 255, 255, 0.8);
  text-decoration: none;
  font-size: 12.5px;
  font-weight: 600;
  transition: all 0.2s ease;

  &:hover {
    border-color: rgba(0, 255, 255, 0.5);
    color: #00ffff;
  }
`;

const LicenseNote = styled.div`
  margin-top: 18px;
  padding: 16px 18px;
  border-radius: 12px;
  background: rgba(184, 135, 255, 0.06);
  border: 1px solid rgba(184, 135, 255, 0.22);
  font-size: 13.5px;
  line-height: 1.65;
  color: rgba(255, 255, 255, 0.65);

  strong { color: #b887ff; }
`;

/* ----------------------------------------------------------------------- */

const About = () => (
  <SeoPageLayout
    title="About ARC-AI | Real-Time AI Assistant with Memory and Automation"
    description="What ARC-AI is, how it evolved from v0.11 to v0.13, and who built it: a real-time assistant combining memory, web research, automation, and tool-driven execution."
    eyebrow="About ARC-AI"
    heroTitle="A practical AI assistant built to take action"
    heroLead="ARC-AI is a real-time assistant for memory, research, automation, and tool-driven work — a MERN-stack agent built to feel like a useful product, not a generic chat window."
    stats={[
      { value: 'Product-first', label: 'Built to be understandable to users, teams, and search engines alike.' },
      { value: 'Tool-driven', label: 'Combines model reasoning with live actions and system integrations.' },
      { value: 'Actively evolving', label: 'Three major releases (v0.11 → v0.13) in the current beta cycle.' },
    ]}
    ctaTitle="Browse the full feature set"
    ctaText="See how ARC-AI is organized into memory, research, automation, and architecture — or jump straight to the live demo."
  >
    <Section>
      <SectionTag>What it's built for</SectionTag>
      <SectionHeading>Beyond answers: remember, research, automate, act</SectionHeading>
      <SectionText>
        The goal is to combine conversational AI with practical execution. Instead of stopping at a reply,
        ARC-AI can recall what it was told weeks ago, pull live information from the web, schedule work for
        later, and take action inside the interface itself.
      </SectionText>
      <BulletList>
        <li>Useful in real workflows, not just demos — memory and automation are meant to be used daily.</li>
        <li>Structured around transparent capabilities and routes, each documented on its own page.</li>
        <li>Built to grow: the multi-workspace runtime exists specifically to scale to more projects over time.</li>
      </BulletList>
    </Section>

    <Divider />

    <Section>
      <SectionTag>Release history</SectionTag>
      <SectionHeading>From a single thread to a multi-workspace runtime</SectionHeading>
      <SectionText>
        ARC-AI has moved through three major beta releases, each one deepening the runtime rather than just
        adding surface features.
      </SectionText>
      <Timeline>
        {RELEASES.map((release) => (
          <TimelineItem key={release.version}>
            <TimelineVersion>{release.version}</TimelineVersion>
            <TimelineTitle>{release.title}</TimelineTitle>
            <TimelineText>{release.text}</TimelineText>
          </TimelineItem>
        ))}
      </Timeline>
    </Section>

    <Section>
      <SectionTag>Stack</SectionTag>
      <SectionHeading>What it's built with</SectionHeading>
      <TechRow>
        <TechChip>React</TechChip>
        <TechChip>Vite</TechChip>
        <TechChip>Tailwind CSS</TechChip>
        <TechChip>Web Speech API</TechChip>
        <TechChip>Node.js</TechChip>
        <TechChip>Express.js</TechChip>
        <TechChip>Socket.IO</TechChip>
        <TechChip>node-cron</TechChip>
        <TechChip>MongoDB Atlas</TechChip>
        <TechChip>Pinecone</TechChip>
        <TechChip>Gemini</TechChip>
        <TechChip>Mistral AI</TechChip>
        <TechChip>Pixtral</TechChip>
        <TechChip>Google Apps Script</TechChip>
      </TechRow>
    </Section>

    <Section>
      <SectionTag>Author & source</SectionTag>
      <SectionHeading>Built from scratch, end to end</SectionHeading>
      <SectionText>
        Architecture, backend, agent system, RAG pipeline, and UI actuation were all built by one author and
        first published with a live demo and deployment.
      </SectionText>

      <AuthorCard>
        <AuthorInfo>
          <h3>Aashutosh Bairagi</h3>
          <p>Original creator of ARC-AI — architecture, backend, agent system, RAG pipeline, and UI actuation.</p>
        </AuthorInfo>
        <AuthorLinks>
          <IconButton href={LINKS.github} target="_blank" rel="noopener noreferrer">
            <GithubIcon /> GitHub
          </IconButton>
          <IconButton href={LINKS.linkedin} target="_blank" rel="noopener noreferrer">
            <LinkedinIcon /> LinkedIn
          </IconButton>
          <IconButton href={LINKS.x} target="_blank" rel="noopener noreferrer">
            <XIcon /> X / Twitter
          </IconButton>
          <IconButton href={LINKS.youtube} target="_blank" rel="noopener noreferrer">
            <YoutubeIcon /> Full demo
          </IconButton>
        </AuthorLinks>
      </AuthorCard>

      <LicenseNote>
        <strong>MIT Licensed, with attribution required.</strong> ARC-AI is open source — free to use, modify,
        and distribute. Any reuse must credit the original author and link back to the{' '}
        <a href={LINKS.repo} target="_blank" rel="noopener noreferrer" style={{ color: '#b887ff' }}>
          source repository
        </a>{' '}
        without claiming the project as someone else's own work.
      </LicenseNote>
    </Section>
  </SeoPageLayout>
);

export default About;