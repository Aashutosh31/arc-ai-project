import React from 'react';
import { Link } from 'react-router-dom';
import styled from 'styled-components';
import SeoPageLayout, { Card, CardGrid, CardText, CardTitle, Section, SectionHeading, SectionText } from '../components/SeoPageLayout';

const FeatureLink = styled(Link)`
  display: inline-flex;
  margin-top: 12px;
  color: #7dd3fc;
  text-decoration: none;
  font-weight: 700;

  &:hover {
    text-decoration: underline;
  }
`;

const Features = () => (
  <SeoPageLayout
    title="ARC AI Features | Memory, Research, Automation, and Tooling"
    description="Explore ARC AI features including RAG memory, web research, automation, UI actuation, and external communication."
    eyebrow="Product overview"
    heroTitle="ARC AI features built for real work"
    heroLead="ARC AI combines long-term memory, live research, automation, and action-taking tools into a single real-time assistant. Each feature is designed to be useful, indexable, and easy to understand for both users and search engines."
    stats={[
      { value: 'RAG memory', label: 'Personalized context that persists across conversations.' },
      { value: 'Live tools', label: 'Web, media, weather, reminders, and other real-time actions.' },
      { value: 'Action routing', label: 'A hybrid system that decides when to answer, fetch, or execute.' },
    ]}
    ctaTitle="See ARC AI in action"
    ctaText="Open the dashboard to chat with the assistant, or jump into the feature pages to understand how the system works under the hood."
  >
    <Section>
      <SectionHeading>Core capabilities</SectionHeading>
      <SectionText>
        The product is organized around a few high-value capabilities that make the assistant feel fast,
        informed, and proactive instead of generic.
      </SectionText>

      <CardGrid>
        <Card>
          <CardTitle>Memory (RAG)</CardTitle>
          <CardText>Stores useful facts, retrieves them semantically, and keeps conversations personalized over time.</CardText>
          <FeatureLink to="/features/rag-memory">Learn about memory</FeatureLink>
        </Card>
        <Card>
          <CardTitle>Web Research</CardTitle>
          <CardText>Pulls current information from the web so answers stay fresh and grounded in real-world data.</CardText>
          <FeatureLink to="/features/web-research">See live research</FeatureLink>
        </Card>
        <Card>
          <CardTitle>Automation</CardTitle>
          <CardText>Turns natural language into scheduled or background actions, making the assistant proactive.</CardText>
          <FeatureLink to="/features/automation">Explore automation</FeatureLink>
        </Card>
        <Card>
          <CardTitle>UI Actuation</CardTitle>
          <CardText>Lets ARC AI drive interfaces, reduce repetitive manual work, and execute user-intent actions.</CardText>
          <FeatureLink to="/architecture">Read the architecture</FeatureLink>
        </Card>
        <Card>
          <CardTitle>External communication</CardTitle>
          <CardText>Connects with services like email, web, media, and reminders through a controlled tool layer.</CardText>
          <FeatureLink to="/architecture">How tools are routed</FeatureLink>
        </Card>
      </CardGrid>
    </Section>
  </SeoPageLayout>
);

export default Features;