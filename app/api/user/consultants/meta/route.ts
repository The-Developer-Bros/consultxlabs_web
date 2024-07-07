import prisma from "@/lib/prisma";

async function fetchDomainsAndSubdomains() {
  try {
    const consultants = await prisma.consultantProfile.findMany({
      select: {
        domain: true,
        subDomains: true
      }
    });

    // Extract unique domains
    const domains = Array.from(new Set(consultants.map(c => c.domain).filter(Boolean)));

    // Extract unique subdomains
    const subdomains = Array.from(new Set(consultants.flatMap(c => c.subDomains).filter(Boolean)));

    return { domains, subdomains }
  } catch (error) {
    console.error('Error fetching domains and subdomains:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest, res: NextResponse) {
  try {
    const { domains, subdomains } = await fetchDomainsAndSubdomains();
    return NextResponse.json({ data: { domains, subdomains } }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}