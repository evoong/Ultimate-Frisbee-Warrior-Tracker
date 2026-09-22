import { Button } from '../lib/shadcn/button'
import { Card, CardHeader, CardTitle, CardContent } from '../lib/shadcn/card'
import { Check } from 'lucide-react'

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    description: 'Essential tracking for casual teams and recreational play.',
    limits: [
      '15 members max',
      '30-day raw stats history',
      '3 playbook strategies',
      '5 AI chat messages / mo',
      'Ad-supported',
    ],
    tier: 'free',
  },
  {
    name: 'Plus',
    price: '$29',
    period: '/ month',
    description: 'Full stats, unlimited strategies, and higher message caps for growing teams.',
    limits: [
      '35 members max',
      'Unlimited stats & history',
      'Unlimited playbook strategies',
      '100 AI chat messages / mo',
      'Ad-free',
    ],
    tier: 'plus',
    popular: true,
  },
  {
    name: 'Premium',
    price: '$79',
    period: '/ month',
    description: 'Unlimited capacity and full AI power for competitive clubs and leagues.',
    limits: [
      'Unlimited members',
      'Unlimited stats & history',
      'Unlimited playbook strategies',
      'Unlimited AI chat',
      'Ad-free',
    ],
    tier: 'premium',
  },
]

export function PricingCards({
  currentTier,
  onSelectTier,
  loadingTier,
  compact = false,
}: {
  currentTier?: string
  onSelectTier?: (tier: string) => void
  loadingTier?: string | null
  compact?: boolean
}) {
  return (
    <div className={`grid max-w-5xl mx-auto ${compact ? 'gap-3 sm:grid-cols-3' : 'gap-6 md:grid-cols-3'}`}> 
      {PLANS.map((plan) => {
        const isCurrent = currentTier === plan.tier
        return (
          <Card
            key={plan.name}
            className={`relative flex flex-col justify-between border ${
              plan.popular ? 'border-primary shadow-md' : 'border-border'
            }`}
          >
            {plan.popular && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs px-3 py-1 rounded-full font-medium">
                Most Popular
              </span>
            )}
            <CardHeader>
              <CardTitle className="text-xl font-bold">{plan.name}</CardTitle>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-3xl font-bold font-mono">{plan.price}</span>
                {plan.period && <span className="text-sm text-muted-foreground">{plan.period}</span>}
              </div>
              <p className="text-sm text-muted-foreground mt-2">{plan.description}</p>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col justify-between">
              <ul className="space-y-3 text-sm mb-6">
                {plan.limits.map((limit, idx) => (
                  <li key={idx} className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-primary shrink-0" />
                    <span>{limit}</span>
                  </li>
                ))}
              </ul>
              {onSelectTier && (
                <Button
                  variant={isCurrent ? 'outline' : plan.popular ? 'default' : 'secondary'}
                  className="w-full"
                  disabled={isCurrent || loadingTier === plan.tier}
                  onClick={() => onSelectTier(plan.tier)}
                >
                  {isCurrent ? 'Current Plan' : loadingTier === plan.tier ? 'Updating…' : `Select ${plan.name}`}
                </Button>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
