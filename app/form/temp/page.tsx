"use client";
/**
 * v0 by Vercel.
 * @see https://v0.dev/t/hO779D5rWqW
 */
import {
  CardTitle,
  CardHeader,
  CardContent,
  CardFooter,
  Card,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  SelectValue,
  SelectTrigger,
  SelectItem,
  SelectContent,
  Select,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { toast } from "@/components/ui/use-toast";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const FormSchema = z.object({
  // brand: z.string(),
  // model: z.string(),
  // description: z.string(),
  // service: z.string(),
  // date: z.string(),
  // email: z
  //   .string({
  //     required_error: "Please select an email to display.",
  //   })
  //   .email(),
  firstName: z.string({
    required_error: "Please enter your first name.",
  }),
  lastName: z.string({
    required_error: "Please enter your last name.",
  }),
  email: z
    .string({
      required_error: "Please enter your email address.",
    })
    .email(),
  // 10 digit phone number
  phone: z
    .string({
      required_error: "Please enter your phone number.",
    })
    .regex(/^\d{10}$/, "Please enter a valid phone number."),
  // ensure 18 years old from today
  birthdate: z
    .string({
      required_error: "Please enter your birthdate.",
    })
    .refine(
      (value) => {
        const date = new Date(value);
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const age = Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
        return age >= 18;
      },
      {
        message: "You must be 18 years or older to continue.",
      }
    ),
  role: z.enum(["consultant", "consultee", "staff", "admin"], {
    required_error: "Please select a role to continue",
  }),
});

export default function CombinedForm() {
  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
  });

  function onSubmit(data: z.infer<typeof FormSchema>) {
    console.log(data);
    toast({
      title: "You submitted the following values:",
      description: (
        <pre className="mt-2 w-[340px] rounded-md bg-slate-950 p-4">
          <code className="text-white">{JSON.stringify(data, null, 2)}</code>
        </pre>
      ),
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <Card className="w-1/2 mx-auto">
        <CardHeader>
          <CardTitle>Make sure all the data is correct!</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="w-2/3 space-y-6 mx-auto"
            >
              <FormField
                control={form.control}
                name="firstName"
                render={({ field }) => (
                  <>
                    <FormItem>
                      <Label htmlFor="firstName">First Name</Label>
                      <Input
                        {...field}
                        id="firstName"
                        placeholder="Enter first name"
                      />
                    </FormItem>
                    <FormMessage />
                  </>
                )}
              />
              <FormField
                control={form.control}
                name="lastName"
                render={({ field }) => (
                  <>
                    <FormItem>
                      <Label htmlFor="lastName">Last Name</Label>
                      <Input
                        {...field}
                        id="lastName"
                        placeholder="Enter last name"
                      />
                    </FormItem>
                    <FormMessage />
                  </>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <>
                    <FormItem>
                      <Label htmlFor="email">Email</Label>
                      <Input {...field} id="email" placeholder="Enter email" />
                    </FormItem>
                    <FormMessage />
                  </>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <>
                    <FormItem>
                      <Label htmlFor="phone">Phone</Label>
                      <Input
                        {...field}
                        id="phone"
                        placeholder="Enter phone"
                        type="tel"
                      />
                    </FormItem>
                    <FormMessage />
                  </>
                )}
              />
              <FormField
                control={form.control}
                name="birthdate"
                render={({ field }) => (
                  <>
                    <FormItem>
                      <Label htmlFor="date">Date of Birth</Label>
                      <Input
                        {...field}
                        defaultValue="2024-07-21"
                        id="date"
                        placeholder="DD.MM.YYYY"
                        type="date"
                      />
                    </FormItem>
                    <FormMessage />
                  </>
                )}
              />
              {/* Role */}
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Role</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a role" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="consultant">Consultant</SelectItem>
                        <SelectItem value="consultee">Consultee</SelectItem>
                        <SelectItem value="staff">Staff</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {/* <Button type="submit">Submit</Button> */}
              <CardFooter className="flex justify-end">
                <Button 
                  className="mr-2 bg-black text-white hover:bg-gray-600"
                  type="submit"
                >Next</Button>
              </CardFooter>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
