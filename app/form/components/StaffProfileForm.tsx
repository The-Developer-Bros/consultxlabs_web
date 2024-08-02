import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StaffProfile, staffProfileSchema } from "../../../schemas/userSchema";

interface Props {
  onSubmit: (data: StaffProfile) => void;
  onBack: () => void;
  initialData: Partial<StaffProfile>;
}

const StaffProfileForm: React.FC<Props> = ({
  onSubmit,
  onBack,
  initialData,
}) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<StaffProfile>({
    resolver: zodResolver(staffProfileSchema),
    defaultValues: initialData,
  });

  const onSubmitForm = (data: StaffProfile) => {
    onSubmit(data);
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmitForm)}
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

      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button type="submit" variant="night">
          Submit
        </Button>
      </div>
    </form>
  );
};

export default StaffProfileForm;
