/**
 * Platform-wide trial pricing controls (single-row config, #880 pattern).
 * The floor sits UNDER every plan's trialPriceInPaise: consultants price
 * their own trials, admin/staff raise the floor when free/underpriced
 * trials need to be squeezed out platform-wide. 0 = free trials allowed.
 */

import prisma from "@/lib/prisma";

export async function getMinTrialPriceInPaise(): Promise<number> {
  const config = await prisma.platformPricingConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
  return config.minTrialPriceInPaise;
}

export async function setMinTrialPriceInPaise(
  minTrialPriceInPaise: number,
): Promise<number> {
  const config = await prisma.platformPricingConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", minTrialPriceInPaise },
    update: { minTrialPriceInPaise },
  });
  return config.minTrialPriceInPaise;
}
