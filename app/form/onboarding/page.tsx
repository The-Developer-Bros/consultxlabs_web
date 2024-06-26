"use client";
import React, { useState } from "react";
import { useForm, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { personalInfoSchema, PersonalInfo, roleSchema, RoleInfo, consultantProfileSchema, ConsultantProfile, consulteeProfileSchema, ConsulteeProfile, staffProfileSchema, StaffProfile } from "../schemas/userSchema";
import PersonalInfoForm from "../components/PersonalInfoForm";
import RoleForm from "../components/RoleForm";
import ConsultantProfileForm from "../components/ConsultantProfileForm";
import ConsulteeProfileForm from "../components/ConsulteeProfileForm";
import StaffProfileForm from "../components/StaffProfileForm";

type FormData = PersonalInfo & RoleInfo & ConsultantProfile & ConsulteeProfile & StaffProfile;

const MultiStepForm: React.FC = () => {
  const [step, setStep] = useState(0);
  const methods = useForm<FormData>({ resolver: zodResolver(personalInfoSchema) });

  const handleNext = (data: FormData) => {
    if (step === 0) {
      methods.trigger().then(isValid => {
        if (isValid) setStep(prevStep => prevStep + 1);
      });
    } else if (step === 1) {
      methods.trigger().then(isValid => {
        if (isValid) setStep(prevStep => prevStep + 1);
      });
    } else if (step === 2) {
      if (methods.getValues().role === "CONSULTANT") {
        methods.trigger().then(isValid => {
          if (isValid) setStep(prevStep => prevStep + 1);
        });
      } else if (methods.getValues().role === "CONSULTEE") {
        methods.trigger().then(isValid => {
          if (isValid) setStep(prevStep => prevStep + 2);
        });
      } else {
        methods.trigger().then(isValid => {
          if (isValid) setStep(prevStep => prevStep + 3);
        });
      }
    }
  };

  const handleBack = () => setStep(prevStep => prevStep - 1);

  const handleSubmit = (data: FormData) => {
    console.log("Submitted Data:", data);
    // Handle form submission here
  };

  return (
    <FormProvider {...methods}>
      {step === 0 && <PersonalInfoForm onNext={() => handleNext(methods.getValues())} />}
      {step === 1 && <RoleForm onNext={() => handleNext(methods.getValues())} onBack={handleBack} />}
      {step === 2 && methods.getValues().role === "CONSULTANT" && <ConsultantProfileForm onNext={() => handleNext(methods.getValues())} onBack={handleBack} />}
      {step === 3 && methods.getValues().role === "CONSULTEE" && <ConsulteeProfileForm onNext={() => handleNext(methods.getValues())} onBack={handleBack} />}
      {step === 4 && methods.getValues().role === "STAFF" && <StaffProfileForm onSubmit={methods.handleSubmit(handleSubmit)} onBack={handleBack} />}
    </FormProvider>
  );
};

export default MultiStepForm;
