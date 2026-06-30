// client/src/pages/WebResearch.jsx

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

const WebResearch = () => (
  <SeoPageLayout
    title="Real-Time Web Research in ARC-AI | Live Data and Scraping"
    description="ARC-AI uses Cheerio-based scraping and API-based research to answer with current weather, news, and live web data."
    eyebrow="Live information"
    heroTitle="Research the live web, not last year's training data"
    heroLead="Static AI answers age the moment they're generated. ARC-AI augments generation with fresh sources, direct API calls, and DOM scraping, so the assistant can answer with what's true right now instead of only what it was trained on."
    stats={[
      { value: 'Cheerio scraping', label: 'Parses page DOM to extract relevant text when live content is needed.' },
      { value: 'Direct API calls', label: 'Fetches weather, news, and other structured live service responses.' },
      { value: 'Streamed back live', label: 'Results return over the same Socket.IO channel as the rest of the chat.' },
    ]}
    ctaTitle="Turn stale answers into live research"
    ctaText="Try ARC-AI when the answer depends on today's data — a current price, the weather, or what a page says right now."
  >
    <Section>
      <SectionTag>Why it matters</SectionTag>
      <SectionHeading>Live retrieval beats a frozen training set</SectionHeading>
      <SectionText>
        A model without live retrieval can only rely on what it already knows. That's fine for stable, general
        knowledge, but it fails for anything that depends on recent change — prices, weather, breaking news, or
        the current state of a specific website.
      </SectionText>
      <BulletList>
        <li>Answers reflect the current state of the web, not a training-time snapshot.</li>
        <li>Research can be tailored to whatever source material the user points to.</li>
        <li>The assistant becomes useful for operational questions, not just conversation.</li>
      </BulletList>
    </Section>

    <Divider />

    <Section>
      <SectionTag>How it works</SectionTag>
      <SectionHeading>Scrape, call, then reason</SectionHeading>
      <CardGrid>
        <Card>
          <CardTitle>Scrape sources</CardTitle>
          <CardText>Cheerio parses page HTML server-side so the assistant can extract the relevant text from a live page in seconds.</CardText>
        </Card>
        <Card>
          <CardTitle>Call APIs directly</CardTitle>
          <CardText>Weather, news, and similar services are queried directly for structured, low-latency live data rather than scraped.</CardText>
        </Card>
        <Card>
          <CardTitle>Blend with reasoning</CardTitle>
          <CardText>Retrieved data is merged into the same execution pipeline that handles memory and tool routing before a reply is generated.</CardText>
        </Card>
      </CardGrid>
      <TechRow>
        <TechChip>Cheerio</TechChip>
        <TechChip>Node.js</TechChip>
        <TechChip>Express APIs</TechChip>
        <TechChip>Socket.IO</TechChip>
      </TechRow>
    </Section>

    <Section>
      <SectionTag>Static vs. live</SectionTag>
      <SectionHeading>Confident is not the same as current</SectionHeading>
      <SectionText>
        Static AI can sound sure of itself while still being out of date. Live AI checks sources first, then
        generates an answer from current context. ARC-AI is built to prefer live retrieval whenever freshness
        actually matters to the question being asked.
      </SectionText>
    </Section>
  </SeoPageLayout>
);

export default WebResearch;