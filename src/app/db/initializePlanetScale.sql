CREATE TABLE
    User (
        phone_number VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255),
        password VARCHAR(255),
        oauth_token VARCHAR(255),
        is_consultant BOOLEAN
    );

CREATE TABLE
    Consultation (
        consultation_id VARCHAR(255) PRIMARY KEY,
        consultant_phone_number VARCHAR(255),
        consultee_phone_number VARCHAR(255),
        start_time DATETIME,
        end_time DATETIME,
        key consultantation_consultant_fk (consultant_phone_number),
        key consultantation_consultee_fk (consultee_phone_number)
    );

CREATE TABLE
    Subscription (
        subscription_id VARCHAR(255) PRIMARY KEY,
        consultant_phone_number VARCHAR(255),
        consultee_phone_number VARCHAR(255),
        start_date DATE,
        end_date DATE,
        key subscription_consultant_fk (consultant_phone_number),
        key subscription_consultee_fk (consultee_phone_number)
    );

CREATE TABLE
    Webinar (
        webinar_id VARCHAR(255) PRIMARY KEY,
        consultant_phone_number VARCHAR(255),
        start_time DATETIME,
        end_time DATETIME,
        key webinar_consultant_fk (consultant_phone_number)
    );

CREATE TABLE
    Class (
        class_id VARCHAR(255) PRIMARY KEY,
        consultant_phone_number VARCHAR(255),
        start_time DATETIME,
        end_time DATETIME,
        key class_consultant_fk (consultant_phone_number)
    );

CREATE TABLE
    PricingModel (
        model_id VARCHAR(255) PRIMARY KEY,
        model_type ENUM(
            'Consultation',
            'Subscription',
            'Webinar',
            'Class'
        )
    );

CREATE TABLE
    Consultation_Pricing (
        consultation_id VARCHAR(255),
        model_id VARCHAR(255),
        PRIMARY KEY (consultation_id, model_id),
        KEY consultation_pricing_consultation_fk (consultation_id),
        KEY consultation_pricing_model_fk (model_id)
    );

CREATE TABLE
    Calendar (
        availability_id VARCHAR(255) PRIMARY KEY,
        consultant_phone_number VARCHAR(255),
        start_time DATETIME,
        end_time DATETIME,
        key calendar_consultant_fk (consultant_phone_number)
    );