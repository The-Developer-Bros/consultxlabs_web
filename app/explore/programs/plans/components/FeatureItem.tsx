type FeatureItemProps = {
  icon: React.ReactNode;
  label: string;
  value: string | number | React.ReactNode;
};

/** One cell of the facts grid under a plan hero: a label, a value, an icon. */
export const FeatureItem = ({ icon, label, value }: FeatureItemProps) => (
  <div className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4">
    <div className="mt-0.5 shrink-0 text-muted-foreground [&>svg]:h-4 [&>svg]:w-4">
      {icon}
    </div>
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
    </div>
  </div>
);
