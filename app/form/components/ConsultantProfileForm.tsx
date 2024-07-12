// components/ConsultantProfileForm.tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import React from "react";
import { useFormContext } from "react-hook-form";
import { ConsultantProfile } from "../schemas/userSchema";

interface Props {
  onNext: () => void;
  onBack: () => void;
}

const ConsultantProfileForm: React.FC<Props> = ({ onNext, onBack }) => {
  const { register, handleSubmit, formState: { errors } } = useFormContext<ConsultantProfile>();

  return (
    <form onSubmit={handleSubmit(onNext)} className="w-full max-w-md space-y-4">
      <div className="space-y-2">
        <Label htmlFor="specialization">Specialization</Label>
        <Input id="specialization" {...register("specialization", { required: true })} />
        {errors.specialization && <span className="text-red-500">{errors.specialization.message}</span>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="experience">Experience</Label>
        <Input id="experience" {...register("experience", { required: true })} />
        {errors.experience && <span className="text-red-500">{errors.experience.message}</span>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="location">Location</Label>
        <Input id="location" {...register("location", { required: true })} />
        {errors.location && <span className="text-red-500">{errors.location.message}</span>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="domain">Domain</Label>
        <Input id="domain" {...register("domain", { required: true })} />
        {errors.domain && <span className="text-red-500">{errors.domain.message}</span>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="subDomains">Sub-Domains (comma-separated)</Label>
        <Input id="subDomains" {...register("subDomains", { required: true })} />
        {errors.subDomains && <span className="text-red-500">{errors.subDomains.message}</span>}
      </div> 
      <div className="w-full justify-around flex space-x-4">
        <Button type="button" onClick={onBack} variant="outline">Back</Button>
        <Button type="submit" variant="night">Next</Button>
      </div>
    </form>
  );
};

export default ConsultantProfileForm;
