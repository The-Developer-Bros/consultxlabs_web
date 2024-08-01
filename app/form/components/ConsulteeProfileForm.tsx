// components/ConsulteeProfileForm.tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import React from "react";
import { useFormContext } from "react-hook-form";
import { ConsulteeProfile } from "../../../schemas/userSchema";

interface Props {
  onNext: () => void;
  onBack: () => void;
}

const ConsulteeProfileForm: React.FC<Props> = ({ onNext, onBack }) => {
  const { register, handleSubmit, formState: { errors } } = useFormContext<ConsulteeProfile>();

  return (
    <form onSubmit={handleSubmit(onNext)} className="w-full max-w-md space-y-4">
      <div className="space-y-2">
        <Label htmlFor="location">Location</Label>
        <Input id="location" {...register("location")} />
      </div>
      <div className="flex space-x-2">
        <Button type="button" onClick={onBack} variant="outline">Back</Button>
        <Button type="submit" variant="night">Next</Button>
      </div>
    </form>
  );
};

export default ConsulteeProfileForm;
