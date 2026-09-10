import React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ConsulteeProfile,
  ConsulteePreferences,
  PersonalInfoAndRole,
} from "@/schemas/user";

type ConsulteeFormData = Partial<PersonalInfoAndRole> &
  Partial<ConsulteeProfile> &
  Partial<ConsulteePreferences> & {
    termsAccepted?: boolean;
    privacyAccepted?: boolean;
    interests?: string[];
    goals?: string;
  };

interface Props {
  onNext: (data: ConsulteeFormData) => void;
  onBack: () => void;
  formData: ConsulteeFormData;
}

const ConsulteeAgreementForm: React.FC<Props> = ({
  onNext,
  onBack,
  formData,
}) => {
  const [termsAccepted, setTermsAccepted] = React.useState(
    formData.termsAccepted || false,
  );
  const [privacyAccepted, setPrivacyAccepted] = React.useState(
    formData.privacyAccepted || false,
  );

  const handleSubmit = () => {
    onNext({
      ...formData,
      termsAccepted,
      privacyAccepted,
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Terms and Conditions
        </h3>
        <p className="text-sm text-muted-foreground">
          Please review and accept our terms to complete your registration
        </p>
      </div>

      {/* Checkboxes */}
      <div className="space-y-4">
        <div className="flex items-center space-x-3 p-4 rounded-lg bg-muted/50 border hover:bg-muted transition-colors">
          <Checkbox
            id="terms"
            checked={termsAccepted}
            // Radix CheckedState = boolean | "indeterminate"; no indeterminate here
            onCheckedChange={(checked) => setTermsAccepted(checked as boolean)}
            className="h-5 w-5"
          />
          <label htmlFor="terms" className="text-sm cursor-pointer font-medium">
            I accept the{" "}
            <a
              href="/terms"
              target="_blank"
              className="text-primary hover:underline transition-colors"
            >
              terms and conditions
            </a>
          </label>
        </div>
        <div className="flex items-center space-x-3 p-4 rounded-lg bg-muted/50 border hover:bg-muted transition-colors">
          <Checkbox
            id="privacy"
            checked={privacyAccepted}
            // Radix CheckedState narrowing — no indeterminate
            onCheckedChange={(checked) =>
              setPrivacyAccepted(checked as boolean)
            }
            className="h-5 w-5"
          />
          <label
            htmlFor="privacy"
            className="text-sm cursor-pointer font-medium"
          >
            I accept the{" "}
            <a
              href="/privacy"
              target="_blank"
              className="text-primary hover:underline transition-colors"
            >
              privacy policy
            </a>
          </label>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex gap-4 pt-4">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          className="flex-1"
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={!termsAccepted || !privacyAccepted}
          className="flex-1"
        >
          Complete Registration
        </Button>
      </div>
    </div>
  );
};

export default ConsulteeAgreementForm;
