// components/StaffProfileForm.tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import React from "react";
import { useFormContext } from "react-hook-form";
import { StaffProfile } from "../schemas/userSchema";

interface Props {
  onSubmit: () => void;
  onBack: () => void;
}

const StaffProfileForm: React.FC<Props> = ({ onSubmit, onBack }) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useFormContext<StaffProfile>();

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full max-w-md space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor="department">Department</Label>
        <Input id="department" {...register("department")} />
        {errors.department && (
          <p className="text-red-500">{errors.department.message}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="position">Position</Label>
        <Input id="position" {...register("position")} />
        {errors.position && (
          <p className="text-red-500">{errors.position.message}</p>
        )}
      </div>
      <div className="flex space-x-2">
        <Button
          type="button"
          onClick={onBack}
          className="bg-gray-200 text-gray-700"
        >
          Back
        </Button>
        <Button type="submit" className="bg-primary text-white">
          Submit
        </Button>
      </div>
    </form>
  );
};

export default StaffProfileForm;
