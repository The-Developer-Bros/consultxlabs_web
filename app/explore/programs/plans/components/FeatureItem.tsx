type FeatureItemProps = {
  icon: React.ReactNode;
  label: string;
  value: string | number | React.ReactNode;
};

export const FeatureItem = ({ icon, label, value }: FeatureItemProps) => (
  <div className="flex items-center gap-3 p-4 bg-muted rounded-xl">
    <div className="w-10 h-10 rounded-lg bg-card border border-border flex items-center justify-center text-muted-foreground flex-shrink-0">
      {icon}
    </div>
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold text-foreground">{value}</p>
    </div>
  </div>
);
