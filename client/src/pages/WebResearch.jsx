import React from 'react';
import SeoPageLayout, { BulletList, Card, CardGrid, CardText, CardTitle, Section, SectionHeading, SectionText } from '../components/SeoPageLayout';

const WebResearch = () => (
  <SeoPageLayout
    title="Real-Time Web Research in ARC AI | Live Data and Scraping"
    description="ARC AI uses real-time scraping and API-based research to answer with current weather, news, and live web data."
    eyebrow="Live information"
    heroTitle="ARC AI can research the web in real time"
    heroLead="Static AI answers age quickly. ARC AI augments generation with fresh sources, APIs, and scraping so the assistant can answer with current information instead of only trained knowledge."
    stats={[
      { value: 'Cheerio scraping', label: 'Extracts content from web pages when live page parsing is needed.' },
      { value: 'API search', label: 'Fetches weather, news, and other up-to-date service responses.' },
      { value: 'Current answers', label: 'Keeps responses aligned with what is happening right now.' },
    ]}
    ctaTitle="Turn stale answers into live research"
    ctaText="Use ARC AI when the answer depends on today’s data, not last year’s training set."
  >
    <Section>
      <SectionHeading>Why real-time data matters</SectionHeading>
      <SectionText>
        A model without live retrieval can only rely on what it already knows. That is fine for general knowledge,
        but it fails for questions that depend on recent changes, updated prices, weather, news, or active websites.
      </SectionText>
      <BulletList>
        <li>Users get answers that reflect the current state of the web.</li>
        <li>Research can be tailored to the latest source material.</li>
        <li>The assistant becomes useful for operations, not just conversation.</li>
      </BulletList>
    </Section>

    <Section>
      <SectionHeading>How ARC AI researches live information</SectionHeading>
      <CardGrid>
        <Card>
          <CardTitle>Scrape sources</CardTitle>
          <CardText>Cheerio parses HTML so the assistant can extract the relevant text from web pages quickly.</CardText>
        </Card>
        <Card>
          <CardTitle>Call APIs</CardTitle>
          <CardText>Weather, news, and similar services are queried directly for structured live data.</CardText>
        </Card>
        <Card>
          <CardTitle>Blend with reasoning</CardTitle>
          <CardText>The assistant combines current data with its reasoning pipeline before answering the user.</CardText>
        </Card>
      </CardGrid>
    </Section>

    <Section>
      <SectionHeading>Static vs live AI responses</SectionHeading>
      <SectionText>
        Static AI can sound confident but still be out of date. Live AI checks sources first, then generates an answer
        from current context. ARC AI is designed to prefer live retrieval whenever freshness matters.
      </SectionText>
    </Section>
  </SeoPageLayout>
);

export default WebResearch;