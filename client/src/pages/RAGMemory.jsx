import React from 'react';
import SeoPageLayout, { BulletList, Card, CardGrid, CardText, CardTitle, Section, SectionHeading, SectionText } from '../components/SeoPageLayout';

const RAGMemory = () => (
  <SeoPageLayout
    title="ARC AI Memory (RAG System) | Long-Term Personalized Context"
    description="Learn how ARC AI uses RAG memory with vector embeddings and semantic search to store context and personalize conversations."
    eyebrow="Memory system"
    heroTitle="ARC AI Memory uses RAG for long-term context"
    heroLead="RAG stands for retrieval-augmented generation. In simple terms, ARC AI stores useful facts, searches them semantically, and feeds the best matches back into the model so conversations stay personalized and relevant."
    stats={[
      { value: 'Mistral embeddings', label: 'Used to convert user facts and conversation context into vectors.' },
      { value: 'Pinecone search', label: 'Supports semantic lookup when ARC AI needs to recall relevant memory.' },
      { value: 'Personalized replies', label: 'The assistant can remember preferences, names, and repeated context.' },
    ]}
    ctaTitle="Make ARC AI remember what matters"
    ctaText="RAG memory is what turns a chatbot into a genuinely useful assistant. Explore the dashboard to see how memory changes the conversation."
  >
    <Section>
      <SectionHeading>What RAG means</SectionHeading>
      <SectionText>
        Traditional chatbots can only respond from the current prompt. RAG adds retrieval, which means the assistant
        can search a memory store for useful context before generating an answer.
      </SectionText>
      <BulletList>
        <li>Recall stored facts instead of forgetting the user after each message.</li>
        <li>Find related memories even when the wording is not exact.</li>
        <li>Keep responses grounded in previously learned context.</li>
      </BulletList>
    </Section>

    <Section>
      <SectionHeading>Why it is better than normal chatbots</SectionHeading>
      <CardGrid>
        <Card>
          <CardTitle>Persistent context</CardTitle>
          <CardText>ARC AI can remember preferences, projects, and recurring tasks across sessions.</CardText>
        </Card>
        <Card>
          <CardTitle>Semantic retrieval</CardTitle>
          <CardText>Vector search finds related facts even if the user phrases the request differently.</CardText>
        </Card>
        <Card>
          <CardTitle>More useful answers</CardTitle>
          <CardText>Answers become more specific because the model receives the best matching memory first.</CardText>
        </Card>
      </CardGrid>
    </Section>

    <Section>
      <SectionHeading>How ARC AI implements memory</SectionHeading>
      <SectionText>
        When ARC AI receives useful user information, it can write that fact into storage, encode it as an embedding,
        and later recall it through semantic similarity searches. That lets the assistant keep context without relying
        on a single conversation window.
      </SectionText>
      <BulletList>
        <li>User facts are extracted and written into a structured memory store.</li>
        <li>Embeddings are created with Mistral to capture meaning, not just keywords.</li>
        <li>Pinecone returns the most relevant matches when the assistant needs context.</li>
      </BulletList>
    </Section>
  </SeoPageLayout>
);

export default RAGMemory;