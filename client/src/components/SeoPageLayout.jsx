import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import styled from 'styled-components';

const Shell = styled.main`
  min-height: 100vh;
  background:
    radial-gradient(circle at top, rgba(0, 255, 255, 0.12), transparent 28%),
    radial-gradient(circle at 80% 0%, rgba(255, 0, 255, 0.1), transparent 24%),
    linear-gradient(180deg, #050816 0%, #070b1b 42%, #02040c 100%);
  color: #eef2ff;
`;

const Inner = styled.div`
  max-width: 1120px;
  margin: 0 auto;
  padding: 32px 20px 72px;

  @media (min-width: 768px) {
    padding: 44px 28px 88px;
  }
`;

const TopBar = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 40px;
  flex-wrap: wrap;
`;

const Brand = styled(Link)`
  color: #ffffff;
  text-decoration: none;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
`;

const Nav = styled.nav`
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
`;

const NavLink = styled(Link)`
  color: rgba(238, 242, 255, 0.78);
  text-decoration: none;
  font-size: 14px;

  &:hover {
    color: #ffffff;
  }
`;

const Hero = styled.section`
  display: grid;
  gap: 18px;
  padding: 40px 0 28px;

  @media (min-width: 900px) {
    grid-template-columns: minmax(0, 1.5fr) minmax(280px, 0.9fr);
    align-items: start;
    gap: 36px;
    padding-top: 54px;
  }
`;

const Eyebrow = styled.p`
  margin: 0;
  color: #6ee7ff;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  font-size: 12px;
  font-weight: 700;
`;

const Title = styled.h1`
  margin: 0;
  font-size: clamp(2.5rem, 5vw, 4.8rem);
  line-height: 0.95;
  letter-spacing: -0.05em;
  max-width: 11ch;
`;

const Lead = styled.p`
  margin: 0;
  max-width: 62ch;
  color: rgba(226, 232, 240, 0.84);
  font-size: 1.05rem;
  line-height: 1.75;
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 8px;
`;

const Button = styled(Link)`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 18px;
  border-radius: 999px;
  text-decoration: none;
  font-weight: 700;
  transition: transform 180ms ease, box-shadow 180ms ease, background 180ms ease;

  &:hover {
    transform: translateY(-1px);
  }
`;

const PrimaryButton = styled(Button)`
  background: linear-gradient(135deg, #67e8f9 0%, #c084fc 100%);
  color: #08111f;
  box-shadow: 0 18px 40px rgba(103, 232, 249, 0.16);
`;

const SecondaryButton = styled(Button)`
  color: #e2e8f0;
  border: 1px solid rgba(148, 163, 184, 0.28);
  background: rgba(15, 23, 42, 0.4);
`;

const SideCard = styled.aside`
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 24px;
  background: rgba(15, 23, 42, 0.68);
  backdrop-filter: blur(14px);
  padding: 22px;
  box-shadow: 0 22px 60px rgba(2, 6, 23, 0.36);
`;

const SideStat = styled.div`
  padding: 16px 0;
  border-bottom: 1px solid rgba(148, 163, 184, 0.14);

  &:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }
`;

const StatValue = styled.div`
  font-size: 1.35rem;
  font-weight: 800;
  color: #ffffff;
`;

const StatLabel = styled.div`
  margin-top: 4px;
  color: rgba(226, 232, 240, 0.72);
  line-height: 1.5;
`;

const Section = styled.section`
  margin-top: 28px;
`;

const SectionHeading = styled.h2`
  margin: 0 0 14px;
  font-size: clamp(1.5rem, 3vw, 2.2rem);
  letter-spacing: -0.03em;
`;

const SectionText = styled.p`
  margin: 0 0 12px;
  max-width: 72ch;
  color: rgba(226, 232, 240, 0.82);
  line-height: 1.75;
`;

const BulletList = styled.ul`
  margin: 14px 0 0;
  padding-left: 20px;
  color: rgba(241, 245, 249, 0.9);
  line-height: 1.7;
`;

const CardGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
`;

const Card = styled.article`
  border-radius: 20px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(15, 23, 42, 0.58);
  padding: 18px;
`;

const CardTitle = styled.h3`
  margin: 0 0 8px;
  font-size: 1.02rem;
`;

const CardText = styled.p`
  margin: 0;
  color: rgba(226, 232, 240, 0.78);
  line-height: 1.7;
`;

const CTA = styled.section`
  margin-top: 44px;
  border-radius: 28px;
  padding: 28px;
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.22), rgba(192, 132, 252, 0.18));
  border: 1px solid rgba(148, 163, 184, 0.18);

  @media (min-width: 768px) {
    padding: 34px 36px;
  }
`;

const CTAInner = styled.div`
  display: grid;
  gap: 14px;
  align-items: center;

  @media (min-width: 800px) {
    grid-template-columns: minmax(0, 1fr) auto;
  }
`;

const CTATitle = styled.h2`
  margin: 0;
  font-size: clamp(1.7rem, 3vw, 2.4rem);
`;

const CTAText = styled.p`
  margin: 0;
  color: rgba(226, 232, 240, 0.84);
  line-height: 1.7;
`;

const SeoPageLayout = ({
  title,
  description,
  eyebrow,
  heroTitle,
  heroLead,
  stats = [],
  children,
  ctaTitle,
  ctaText,
  ctaPrimaryHref = '/dashboard',
  ctaPrimaryLabel = 'Open ARC AI',
  ctaSecondaryHref = '/login',
  ctaSecondaryLabel = 'Sign in',
}) => {
  useEffect(() => {
    document.title = title;

    const metaDescription = document.querySelector('meta[name="description"]') || document.createElement('meta');
    metaDescription.setAttribute('name', 'description');
    metaDescription.setAttribute('content', description);

    if (!metaDescription.parentElement) {
      document.head.appendChild(metaDescription);
    }
  }, [title, description]);

  return (
    <Shell>
      <Inner>
        <TopBar>
          <Brand to="/features">ARC AI</Brand>
          <Nav aria-label="Marketing pages">
            <NavLink to="/features">Features</NavLink>
            <NavLink to="/features/rag-memory">Memory</NavLink>
            <NavLink to="/features/web-research">Research</NavLink>
            <NavLink to="/features/automation">Automation</NavLink>
            <NavLink to="/architecture">Architecture</NavLink>
          </Nav>
        </TopBar>

        <Hero>
          <div>
            <Eyebrow>{eyebrow}</Eyebrow>
            <Title>{heroTitle}</Title>
            <Lead>{heroLead}</Lead>
            <Actions>
              <PrimaryButton to={ctaPrimaryHref}>{ctaPrimaryLabel}</PrimaryButton>
              <SecondaryButton to={ctaSecondaryHref}>{ctaSecondaryLabel}</SecondaryButton>
            </Actions>
          </div>

          <SideCard>
            {stats.map((stat) => (
              <SideStat key={stat.label}>
                <StatValue>{stat.value}</StatValue>
                <StatLabel>{stat.label}</StatLabel>
              </SideStat>
            ))}
          </SideCard>
        </Hero>

        {children}

        <CTA>
          <CTAInner>
            <div>
              <CTATitle>{ctaTitle}</CTATitle>
              <CTAText>{ctaText}</CTAText>
            </div>
            <Actions>
              <PrimaryButton to={ctaPrimaryHref}>{ctaPrimaryLabel}</PrimaryButton>
              <SecondaryButton to={ctaSecondaryHref}>{ctaSecondaryLabel}</SecondaryButton>
            </Actions>
          </CTAInner>
        </CTA>
      </Inner>
    </Shell>
  );
};

export { Card, CardGrid, CardText, CardTitle, BulletList, Section, SectionHeading, SectionText };
export default SeoPageLayout;