import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import React from "react";
import { useForm } from "react-hook-form";
import { ConsultantProfile } from "../../../schemas/userSchema";

interface Props {
  onNext: (data: Partial<ConsultantProfile>) => void;
  onBack: () => void;
  initialData: Partial<ConsultantProfile>;
}

const ConsultantProfileForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ConsultantProfile>({
    defaultValues: initialData,
    mode: "onChange",
  });

  const onSubmit = (data: ConsultantProfile) => {
    onNext(data);
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full max-w-md space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor="specialization">Specialization</Label>
        <Input
          id="specialization"
          {...register("specialization", { required: true })}
        />
        {errors.specialization && (
          <p className="text-red-500">{errors.specialization.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="experience">Experience (years)</Label>
        <Input
          id="experience"
          {...register("experience", { required: true })}
        />
        {errors.experience && (
          <p className="text-red-500">{errors.experience.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="location">Location</Label>
        <Input id="location" {...register("location", { required: true })} />
        {errors.location && (
          <p className="text-red-500">{errors.location.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="domain">Domain</Label>
        <Input id="domain" {...register("domain", { required: true })} />
        {errors.domain && (
          <p className="text-red-500">{errors.domain.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="subDomains">Sub-Domains (comma-separated)</Label>
        <Input
          id="subDomains"
          {...register("subDomains", { required: true })}
        />
        {errors.subDomains && (
          <p className="text-red-500">{errors.subDomains.message}</p>
        )}
      </div>

      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button type="submit" variant="night">
          Next
        </Button>
      </div>
    </form>
  );
};

export default ConsultantProfileForm;
