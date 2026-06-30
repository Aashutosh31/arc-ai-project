// client/src/pages/RAGMemory.jsx

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

const LIFECYCLE = [
  {
    title: 'Conversation history',
    text: 'The raw, ordered record of what was said in the current session — the closest thing to short-term memory.',
  },
  {
    title: 'Working context',
    text: 'A trimmed, active slice of the conversation kept in front of the model for the current turn.',
  },
  {
    title: 'Semantic memory',
    text: 'Embedded chunks of past discussion, retrievable by meaning rather than exact keywords.',
  },
  {
    title: 'Long-term user facts',
    text: 'Durable facts about the user — preferences, recurring projects, names — that persist across every session.',
  },
];

const RAGMemory = () => (
  <SeoPageLayout
    title="ARC-AI Memory (RAG System) | Long-Term Personalized Context"
    description="How ARC-AI uses retrieval-augmented generation with Mistral embeddings, Pinecone, and a four-layer memory lifecycle to personalize conversations."
    eyebrow="Memory system"
    heroTitle="Memory built on retrieval, not just a longer prompt"
    heroLead="RAG stands for retrieval-augmented generation. ARC-AI writes useful facts to a vector store, searches them semantically, and feeds the best matches back into the model — so conversations stay personalized without needing the entire history every time."
    stats={[
      { value: 'Mistral embeddings', label: 'Converts user facts and context into vectors for semantic search.' },
      { value: 'Pinecone, per workspace', label: 'Isolated vector namespaces keep memory scoped to the right project.' },
      { value: '4-layer lifecycle', label: 'History, working context, semantic memory, and long-term facts.' },
    ]}
    ctaTitle="Make ARC-AI remember what matters"
    ctaText="RAG memory is what turns a chatbot into a genuinely useful assistant. Try the live demo to see how memory changes the conversation over time."
  >
    <Section>
      <SectionTag>What RAG means</SectionTag>
      <SectionHeading>Retrieval before generation</SectionHeading>
      <SectionText>
        A plain chatbot can only respond to the current prompt. Retrieval-augmented generation adds a search step
        first: the assistant looks through a memory store for relevant context, then generates an answer grounded
        in what it finds.
      </SectionText>
      <BulletList>
        <li>Recall stored facts instead of forgetting the user after each message.</li>
        <li>Find related memories even when the wording does not match exactly.</li>
        <li>Keep responses grounded in previously learned context, not just the last few messages.</li>
      </BulletList>
    </Section>

    <Divider />

    <Section>
      <SectionTag>Memory lifecycle</SectionTag>
      <SectionHeading>Four layers, separated on purpose</SectionHeading>
      <SectionText>
        Treating every fact the same way creates noisy retrieval. ARC-AI keeps a clear separation between what is
        ephemeral and what should persist for months.
      </SectionText>
      <CardGrid>
        {LIFECYCLE.map((layer) => (
          <Card key={layer.title}>
            <CardTitle>{layer.title}</CardTitle>
            <CardText>{layer.text}</CardText>
          </Card>
        ))}
      </CardGrid>
    </Section>

    <Section>
      <SectionTag>Retrieval quality</SectionTag>
      <SectionHeading>Relevance over recall volume</SectionHeading>
      <SectionText>
        The retrieval layer does not just return the closest vector match. It scores results for relevance, weighs
        recency so newer facts can outrank stale ones, and suppresses near-duplicate memories before anything
        reaches the model — keeping context low-noise instead of bloated.
      </SectionText>
      <BulletList>
        <li>User facts are extracted from conversation and written into a structured memory store.</li>
        <li>Embeddings are generated with Mistral to capture meaning, not just keywords.</li>
        <li>Pinecone returns the most relevant matches, scoped to an isolated namespace per workspace.</li>
        <li>Relevance scoring, recency weighting, and duplicate suppression keep the final context window clean.</li>
      </BulletList>
      <TechRow>
        <TechChip>Mistral embeddings</TechChip>
        <TechChip>Pinecone vector DB</TechChip>
        <TechChip>Workspace namespaces</TechChip>
        <TechChip>MongoDB Atlas</TechChip>
      </TechRow>
    </Section>
  </SeoPageLayout>
);

export default RAGMemory;