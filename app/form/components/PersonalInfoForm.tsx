import React from "react";
import { useFormContext } from "react-hook-form";
import { PersonalInfo } from "../schemas/userSchema";

interface Props {
  onNext: () => void;
}

const PersonalInfoForm: React.FC<Props> = ({ onNext }) => {
  const { register, handleSubmit, formState: { errors } } = useFormContext<PersonalInfo>();

  return (
    <form onSubmit={handleSubmit(onNext)}>
      <div>
        <label>Name</label>
        <input {...register("name")} />
        {errors.name && <p>{errors.name.message}</p>}
      </div>
      <div>
        <label>Email</label>
        <input {...register("email")} />
        {errors.email && <p>{errors.email.message}</p>}
      </div>
      <button type="submit">Next</button>
    </form>
  );
};

export default PersonalInfoForm;