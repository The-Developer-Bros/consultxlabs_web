import React from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  PersonalInfoAndRole,
  personalInfoAndRoleSchema,
} from "../../../schemas/userSchema";

interface Props {
  onNext: (data: PersonalInfoAndRole) => void;
  initialData: Partial<PersonalInfoAndRole>;
}

const PersonalInfoAndRoleForm: React.FC<Props> = ({ onNext, initialData }) => {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<PersonalInfoAndRole>({
    resolver: zodResolver(personalInfoAndRoleSchema),
    defaultValues: initialData,
  });

  const onSubmit = (data: PersonalInfoAndRole) => {
    onNext(data);
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full max-w-md space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor="name">Full Name</Label>
        <Input id="name" {...register("name")} />
        {errors.name && <p className="text-red-500">{errors.name.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" {...register("email")} />
        {errors.email && <p className="text-red-500">{errors.email.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="phone">Phone</Label>
        <Input id="phone" {...register("phone")} />
        {errors.phone && <p className="text-red-500">{errors.phone.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="address">Address</Label>
        <Input id="address" {...register("address")} />
        {errors.address && (
          <p className="text-red-500">{errors.address.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label>Role</Label>
        <Controller
          name="role"
          control={control}
          render={({ field }) => (
            <RadioGroup
              onValueChange={field.onChange}
              value={field.value}
              className="flex flex-col space-y-1"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="CONSULTEE" id="consultee" />
                <Label htmlFor="consultee">Consultee</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="CONSULTANT" id="consultant" />
                <Label htmlFor="consultant">Consultant</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="STAFF" id="staff" />
                <Label htmlFor="staff">Staff</Label>
              </div>
            </RadioGroup>
          )}
        />
        {errors.role && <p className="text-red-500">{errors.role.message}</p>}
      </div>

      <Button type="submit" variant="night" className="w-full">
        Next
      </Button>
    </form>
  );
};

export default PersonalInfoAndRoleForm;
